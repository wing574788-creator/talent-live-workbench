/**
 * 模型配置（PRD 9.3）：提供方、按用途指定的模型，存在数据目录里的 ai-config.json；
 * API Key 单独存在 secrets.json（CLAUDE.md 铁律 8）：不进数据库、不写日志、永远不返回前端——
 * 前端只能知道"某个提供方有没有配置 Key"。
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { DomainError } from '../domain/errors.ts';

export const PURPOSES = ['extract', 'chat', 'summary', 'mapping'] as const;
export type Purpose = (typeof PURPOSES)[number];
export const PURPOSE_LABELS: Record<Purpose, string> = {
  extract: '录入提取（聊天文字 / 截图 → 改动）',
  chat: '问答',
  summary: '首页摘要',
  mapping: '导入映射建议',
};

/** 提供方种类。deepseek / anthropic / openai 用 Pi 自带的目录，其余走 OpenAI 兼容接口。 */
export const PROVIDER_KINDS = [
  'deepseek',
  'anthropic',
  'openai',
  'openai-compatible',
  'ollama',
] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** 外发限制用：模型在境内、境外还是本机 */
export const REGIONS = ['domestic', 'foreign', 'local'] as const;
export type Region = (typeof REGIONS)[number];

export const KIND_DEFAULT_REGION: Record<ProviderKind, Region> = {
  deepseek: 'domestic',
  anthropic: 'foreign',
  openai: 'foreign',
  'openai-compatible': 'domestic',
  ollama: 'local',
};

export const providerSchema = z
  .object({
    /** 提供方 ID：字母数字和短横线。内置种类就用种类名，兼容接口自己起名 */
    id: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/, 'ID 只能用小写字母、数字、短横线'),
    kind: z.enum(PROVIDER_KINDS),
    label: z.string().trim().min(1).max(40),
    region: z.enum(REGIONS),
    /** openai-compatible / ollama 必填 */
    baseUrl: z.string().trim().url().optional(),
    /** openai-compatible / ollama 的模型 ID 列表 */
    models: z.array(z.string().trim().min(1)).max(50).optional(),
  })
  .strict();
export type ProviderSetting = z.infer<typeof providerSchema>;

const modelRef = z.object({ provider: z.string(), model: z.string() }).nullable();
export const configSchema = z.object({
  providers: z.array(providerSchema),
  purposes: z.object({ extract: modelRef, chat: modelRef, summary: modelRef, mapping: modelRef }),
});
export type AiConfig = z.infer<typeof configSchema>;

export const emptyConfig = (): AiConfig => ({
  providers: [],
  purposes: { extract: null, chat: null, summary: null, mapping: null },
});

/** 内置提供方的 Pi 提供方 ID（就是种类名） */
export const BUILTIN_KINDS: ProviderKind[] = ['deepseek', 'anthropic', 'openai'];

export class AiConfigStore {
  private readonly cfgFile: string;
  private readonly secretFile: string;

  constructor(readonly dataDir: string) {
    this.cfgFile = path.join(dataDir, 'ai-config.json');
    this.secretFile = path.join(dataDir, 'secrets.json');
  }

  // ───────────── 配置（不含密钥） ─────────────
  load(): AiConfig {
    if (!fs.existsSync(this.cfgFile)) return emptyConfig();
    try {
      return configSchema.parse(JSON.parse(fs.readFileSync(this.cfgFile, 'utf8')));
    } catch {
      return emptyConfig(); // 文件损坏时当作未配置，不让整个应用起不来
    }
  }

  private write(cfg: AiConfig) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.cfgFile, JSON.stringify(cfg, null, 2));
  }

  upsertProvider(input: unknown): ProviderSetting {
    const p = providerSchema.parse(input);
    if (
      (p.kind === 'openai-compatible' || p.kind === 'ollama') &&
      (!p.baseUrl || !p.models?.length)
    ) {
      throw new DomainError('validation', '兼容接口和 Ollama 需要填写接口地址和至少一个模型 ID');
    }
    if (BUILTIN_KINDS.includes(p.kind) && p.id !== p.kind) {
      throw new DomainError('validation', `内置提供方的 ID 必须是「${p.kind}」`);
    }
    const cfg = this.load();
    const i = cfg.providers.findIndex((x) => x.id === p.id);
    if (i >= 0) cfg.providers[i] = p;
    else cfg.providers.push(p);
    this.write(cfg);
    return p;
  }

  removeProvider(id: string) {
    const cfg = this.load();
    cfg.providers = cfg.providers.filter((p) => p.id !== id);
    for (const k of PURPOSES) if (cfg.purposes[k]?.provider === id) cfg.purposes[k] = null;
    this.write(cfg);
    this.deleteKey(id);
  }

  setPurpose(purpose: Purpose, ref: { provider: string; model: string } | null) {
    const cfg = this.load();
    if (ref && !cfg.providers.some((p) => p.id === ref.provider)) {
      throw new DomainError('validation', '先添加这个提供方，再用它指定用途');
    }
    cfg.purposes[purpose] = ref;
    this.write(cfg);
  }

  // ───────────── 密钥 ─────────────
  private readSecrets(): Record<string, string> {
    try {
      return JSON.parse(fs.readFileSync(this.secretFile, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private writeSecrets(s: Record<string, string>) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.secretFile, JSON.stringify(s), { mode: 0o600 });
    try {
      fs.chmodSync(this.secretFile, 0o600);
    } catch {
      /* Windows 上忽略 */
    }
  }

  setKey(providerId: string, key: string) {
    const k = key.trim();
    if (k.length < 8)
      throw new DomainError('validation', 'API Key 看起来太短了，请检查是否复制完整');
    if (/\s/.test(k)) throw new DomainError('validation', 'API Key 里不能有空格或换行');
    this.writeSecrets({ ...this.readSecrets(), [providerId]: k });
  }

  deleteKey(providerId: string) {
    const s = this.readSecrets();
    delete s[providerId];
    this.writeSecrets(s);
  }

  /** 只给后端内部取用，绝不能出现在任何 HTTP 响应或日志里 */
  getKey(providerId: string): string | undefined {
    return this.readSecrets()[providerId];
  }

  hasKey(providerId: string): boolean {
    return !!this.readSecrets()[providerId];
  }

  /** 给前端看的视图：每个提供方只带"有没有 Key"，不带 Key 本身 */
  publicView() {
    const cfg = this.load();
    return {
      providers: cfg.providers.map((p) => ({
        ...p,
        hasKey: p.kind === 'ollama' ? true : this.hasKey(p.id),
      })),
      purposes: cfg.purposes,
    };
  }
}

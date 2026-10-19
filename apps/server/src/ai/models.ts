import fs from 'node:fs';
import path from 'node:path';
import { DomainError } from '../domain/errors.ts';
import {
  PURPOSE_LABELS,
  BUILTIN_KINDS,
  type AiConfigStore,
  type ProviderSetting,
  type Purpose,
} from './config.ts';
import { loadModelRuntime, type PiModel, type PiModelRuntime } from './pi.ts';

export class AiNotConfigured extends DomainError {
  constructor(message: string) {
    super('ai_not_configured', message);
  }
}

export interface ResolvedModel {
  purpose: Purpose;
  provider: ProviderSetting;
  modelId: string;
  model: PiModel;
  modelRuntime: PiModelRuntime;
  agentDir: string;
}

/** 按用途解析出要用的模型。没配置、没填 Key、模型不存在时给出能看懂的提示。 */
export class ModelResolver {
  constructor(private readonly store: AiConfigStore) {}

  get agentDir() {
    return path.join(this.store.dataDir, 'pi');
  }

  /** 把兼容接口和 Ollama 写成 Pi 的 models.json；Key 不写进文件，运行时注入 */
  private writeModelsJson() {
    const providers: Record<string, unknown> = {};
    for (const p of this.store.load().providers) {
      if (BUILTIN_KINDS.includes(p.kind)) continue;
      providers[p.id] = {
        baseUrl: p.baseUrl,
        api: 'openai-completions',
        apiKey: 'runtime-injected',
        models: (p.models ?? []).map((id) => ({ id })),
      };
    }
    fs.mkdirSync(this.agentDir, { recursive: true });
    const file = path.join(this.agentDir, 'models.json');
    fs.writeFileSync(file, JSON.stringify({ providers }, null, 2));
    return file;
  }

  async runtime(): Promise<PiModelRuntime> {
    const modelsPath = this.writeModelsJson();
    const rt = await loadModelRuntime({
      authPath: path.join(this.agentDir, 'auth.json'),
      modelsPath,
    });
    for (const p of this.store.load().providers) {
      const key = p.kind === 'ollama' ? 'ollama' : this.store.getKey(p.id);
      if (key) await rt.setRuntimeApiKey(p.id, key);
    }
    return rt;
  }

  async resolve(purpose: Purpose): Promise<ResolvedModel> {
    const cfg = this.store.load();
    const ref = cfg.purposes[purpose];
    if (!ref)
      throw new AiNotConfigured(
        `还没有为「${PURPOSE_LABELS[purpose]}」指定模型。到「设置 → 模型」里添加提供方、填入 API Key 并指定用途。`,
      );
    const provider = cfg.providers.find((p) => p.id === ref.provider);
    if (!provider) throw new AiNotConfigured('指定的模型提供方已被删除，请重新选择');
    if (provider.kind !== 'ollama' && !this.store.hasKey(provider.id)) {
      throw new AiNotConfigured(
        `「${provider.label}」还没有填写 API Key，到「设置 → 模型」里填写。`,
      );
    }
    const modelRuntime = await this.runtime();
    const model = modelRuntime.getModel(provider.id, ref.model);
    if (!model)
      throw new AiNotConfigured(`「${provider.label}」下没有模型「${ref.model}」，请重新选择。`);
    return { purpose, provider, modelId: ref.model, model, modelRuntime, agentDir: this.agentDir };
  }

  /** 某个提供方有哪些模型可选（内置的取 Pi 目录，其余取配置的 ID 列表） */
  async modelsOf(providerId: string): Promise<{ id: string; name: string }[]> {
    const p = this.store.load().providers.find((x) => x.id === providerId);
    if (!p) throw new DomainError('not_found', '提供方不存在');
    if (!BUILTIN_KINDS.includes(p.kind)) return (p.models ?? []).map((id) => ({ id, name: id }));
    const rt = await this.runtime();
    return rt.getModels(p.id).map((m) => ({ id: m.id, name: m.name ?? m.id }));
  }
}

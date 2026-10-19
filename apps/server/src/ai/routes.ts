/**
 * AI 相关的 REST 路由：模型配置、API Key、外发规则、外发日志。
 * API Key 只写不读：任何响应里都只有"有没有 Key"，不会出现 Key 本身。
 */
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { DomainError } from '../domain/errors.ts';
import { jsonBody } from '../api/util.ts';
import { todayShanghai } from '../domain/automation.ts';
import { suggestMappingWithAi } from './mapping.ts';
import {
  KIND_DEFAULT_REGION,
  PROVIDER_KINDS,
  PURPOSES,
  PURPOSE_LABELS,
  REGIONS,
  type Purpose,
} from './config.ts';
import type { AttachmentStore } from '../storage.ts';
import { appliedOf } from '../domain/types.ts';
import type { AiContext } from './index.ts';
import {
  FIXED_MASKED,
  MODULE_KEYS,
  OUTBOUND_MODULES,
  defaultPolicy,
  loadPolicy,
  savePolicy,
  type OutboundPolicy,
} from './outbound.ts';

/** 配置页的预设：选一个种类就带出默认的名称和区域 */
const PRESETS = [
  {
    kind: 'deepseek',
    id: 'deepseek',
    label: 'DeepSeek',
    region: 'domestic',
    hint: '境内可用，价格低；在 platform.deepseek.com 申请 API Key',
  },
  {
    kind: 'anthropic',
    id: 'anthropic',
    label: 'Anthropic',
    region: 'foreign',
    hint: '境外模型，需要网络可达',
  },
  {
    kind: 'openai',
    id: 'openai',
    label: 'OpenAI',
    region: 'foreign',
    hint: '境外模型，需要网络可达',
  },
  {
    kind: 'openai-compatible',
    id: '',
    label: '',
    region: 'domestic',
    hint: '通义、Kimi、智谱等 OpenAI 兼容接口：填接口地址和模型 ID',
  },
  {
    kind: 'ollama',
    id: 'ollama',
    label: '本机 Ollama',
    region: 'local',
    hint: '完全在本机运行，数据不出本机；默认地址 http://127.0.0.1:11434/v1',
  },
] as const;

const policySchema = z
  .object({
    allowOutbound: z.boolean(),
    region: z.enum(['any', 'domestic', 'local']),
    modules: z.record(z.enum(['allow', 'deny'])),
    fields: z.record(z.enum(['allow', 'deny', 'mask'])),
  })
  .strict();

const csvCell = (v: unknown) =>
  `"${String(v ?? '')
    .replace(/"/g, '""')
    .replace(/\r?\n/g, ' ')}"`;

export function createAiApi(ai: AiContext, store: AttachmentStore) {
  const r = new Hono();
  const { domain } = ai;
  const config = ai.store;

  r.get('/config', (c) => {
    const view = config.publicView();
    return c.json({
      ...view,
      presets: PRESETS,
      kinds: PROVIDER_KINDS,
      regions: REGIONS,
      purposeList: PURPOSES.map((p) => ({ key: p, label: PURPOSE_LABELS[p] })),
      configured: PURPOSES.some((p) => !!view.purposes[p]),
    });
  });

  r.put('/providers/:id', async (c) => {
    const body = await jsonBody(c);
    const id = c.req.param('id');
    const kind = body.kind as (typeof PROVIDER_KINDS)[number];
    const p = config.upsertProvider({
      ...body,
      id,
      region: body.region ?? KIND_DEFAULT_REGION[kind],
    });
    return c.json({ ...p, hasKey: config.hasKey(p.id) });
  });
  r.delete('/providers/:id', (c) => {
    config.removeProvider(c.req.param('id'));
    return c.json({ ok: true });
  });
  /** 只写不读 */
  r.put('/providers/:id/key', async (c) => {
    const id = c.req.param('id');
    if (!config.load().providers.some((p) => p.id === id)) {
      throw new DomainError('not_found', '提供方不存在，请先添加');
    }
    const { key } = await jsonBody(c);
    config.setKey(id, String(key ?? ''));
    return c.json({ hasKey: true });
  });
  r.delete('/providers/:id/key', (c) => {
    config.deleteKey(c.req.param('id'));
    return c.json({ hasKey: false });
  });
  r.get('/providers/:id/models', async (c) =>
    c.json({ models: await ai.resolver.modelsOf(c.req.param('id')) }),
  );

  r.put('/purposes/:purpose', async (c) => {
    const purpose = c.req.param('purpose') as Purpose;
    if (!PURPOSES.includes(purpose)) throw new DomainError('not_found', '未知用途');
    const body = await jsonBody(c);
    config.setPurpose(
      purpose,
      body.provider && body.model
        ? { provider: String(body.provider), model: String(body.model) }
        : null,
    );
    return c.json(config.publicView().purposes);
  });

  // ───────────── 对话 ─────────────
  /** SSE 流式对话：事件见 ChatEvent；客户端断开连接 = 停止 */
  r.post('/chat', async (c) => {
    const body = await jsonBody(c);
    return streamSSE(c, async (stream) => {
      const abort = new AbortController();
      stream.onAbort(() => abort.abort());
      // 按顺序写出，结束前等全部写完
      let chain: Promise<unknown> = Promise.resolve();
      await ai.service.chat(
        {
          sessionId: body.sessionId || undefined,
          text: String(body.text ?? ''),
          mode: body.mode === 'chat' ? 'chat' : 'extract',
          confirmed: Array.isArray(body.confirmed) ? body.confirmed.map(String) : [],
          context: body.context && typeof body.context === 'object' ? body.context : undefined,
          note: body.note ? String(body.note) : undefined,
          carryText: body.carryText ? String(body.carryText) : undefined,
          sourceAttachmentId: body.sourceAttachmentId ? String(body.sourceAttachmentId) : undefined,
        },
        (e) => {
          chain = chain.then(() => stream.writeSSE({ event: e.type, data: JSON.stringify(e) }));
        },
        abort.signal,
      );
      await chain;
    });
  });
  r.get('/sessions', (c) => c.json({ rows: ai.service.listSessions() }));
  r.get('/sessions/:id', (c) => {
    const s = ai.service.getSession(c.req.param('id'));
    return c.json({ id: s.id, title: s.title, transcript: s.transcript });
  });
  r.delete('/sessions/:id', (c) => {
    ai.service.deleteSession(c.req.param('id'));
    return c.json({ ok: true });
  });

  // ───────────── 截图：本地 OCR（图片不外发，只有识别出的文字会在你确认后发送） ─────────────
  r.get('/ocr/status', async (c) =>
    c.json({ engine: ai.ocr.engineName, ...(await ai.ocr.status()) }),
  );
  r.post('/ocr', async (c) => {
    const form = await c.req.parseBody();
    const file = form['file'];
    if (!(file instanceof File)) throw new DomainError('validation', '请选择截图文件');
    const res = await ai.ocr.recognize(new Uint8Array(await file.arrayBuffer()), file.type);
    // 截图留档：之后在跟进记录里可以看到出处
    const saved = await store.saveImage(file);
    const att = appliedOf(
      domain.entity('attachment').create(domain.userActor({ source: '截图录入' }), {
        kind: 'screenshot',
        path: saved.path,
        originalName: file.name,
        mime: saved.mime,
        sizeBytes: saved.sizeBytes,
      }),
    ).row;
    return c.json({ ...res, attachmentId: att.id });
  });

  // ───────────── 首页摘要、导入映射建议 ─────────────
  /** 当天的 AI 摘要（有缓存直接返回）；没配置模型时 available = false，首页继续显示规则概况 */
  r.get('/summary', async (c) => {
    try {
      const res = await ai.summary.get(todayShanghai(), c.req.query('refresh') === '1');
      return c.json({ available: true, ...res });
    } catch (err) {
      const e = err as DomainError;
      if (e.code === 'ai_not_configured') return c.json({ available: false, message: e.message });
      if (e instanceof DomainError)
        return c.json({ available: true, error: e.message, cached: false, content: null });
      throw err;
    }
  });
  r.post('/mapping-suggest', async (c) => {
    const { target, columns } = await jsonBody(c);
    if (!Array.isArray(columns)) throw new DomainError('validation', '缺少列信息');
    return c.json(
      await suggestMappingWithAi(ai, {
        target,
        columns: columns.map((x: Record<string, unknown>) => ({
          index: Number(x.index),
          name: String(x.name ?? ''),
          samples: Array.isArray(x.samples) ? (x.samples as never[]) : [],
        })),
      }),
    );
  });

  // ───────────── 外发规则与日志 ─────────────
  r.get('/outbound', (c) =>
    c.json({
      policy: loadPolicy(domain),
      defaults: defaultPolicy(),
      catalog: MODULE_KEYS.map((m) => ({
        key: m,
        label: OUTBOUND_MODULES[m].label,
        fields: OUTBOUND_MODULES[m].fields,
        fixedMasked: FIXED_MASKED[m],
      })),
      fixedRule:
        '手机号、微信号、收货地址、真实姓名在发给模型之前一律在本机脱敏，这一条不可关闭。图片不会发给模型。',
    }),
  );
  r.put('/outbound', async (c) => {
    const parsed = policySchema.safeParse(await jsonBody(c));
    if (!parsed.success) throw new DomainError('validation', '外发规则格式不对');
    const policy = parsed.data as OutboundPolicy;
    for (const m of Object.keys(policy.modules)) {
      if (!(MODULE_KEYS as string[]).includes(m))
        throw new DomainError('validation', `未知模块：${m}`);
    }
    for (const f of Object.keys(policy.fields)) {
      const [m, k, ...rest] = f.split('.');
      const fields = OUTBOUND_MODULES[m as keyof typeof OUTBOUND_MODULES]?.fields as
        Record<string, string> | undefined;
      const ok =
        !!fields && (k === 'custom' ? rest.length === 1 : rest.length === 0 && k! in fields);
      if (!ok) throw new DomainError('validation', `未知字段：${f}`);
    }
    savePolicy(domain, policy);
    return c.json({ policy: loadPolicy(domain) });
  });

  r.get('/outbound/logs', (c) => {
    const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 200);
    const offset = Number(c.req.query('offset') ?? 0) || 0;
    const res = domain
      .entity('outbound_log')
      .query({ sort: 'createdAt', dir: 'desc', limit, offset });
    return c.json({
      total: res.total,
      rows: res.rows.map((x) => ({
        id: x.id,
        createdAt: x.createdAt,
        model: x.model,
        module: x.module,
        size: String(x.payload ?? '').length,
        preview: String(x.payload ?? '').slice(0, 160),
      })),
    });
  });
  r.get('/outbound/logs/export', () => {
    const rows = domain
      .entity('outbound_log')
      .query({ sort: 'createdAt', dir: 'desc', limit: 1000 }).rows;
    const head = '时间,模型,用途,发出的内容（已脱敏）';
    const csv = [
      head,
      ...rows.map((x) => [x.createdAt, x.model, x.module, x.payload].map(csvCell).join(',')),
    ].join('\r\n');
    return new Response('﻿' + csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="outbound-log.csv"',
      },
    });
  });
  r.get('/outbound/logs/:id', (c) => {
    const x = domain.entity('outbound_log').require(c.req.param('id'));
    return c.json({
      id: x.id,
      createdAt: x.createdAt,
      model: x.model,
      module: x.module,
      payload: x.payload,
    });
  });

  return r;
}

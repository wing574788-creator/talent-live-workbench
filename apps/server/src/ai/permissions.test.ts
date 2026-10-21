import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createFauxModel, fauxAssistantMessage, fauxText } from '../agent/faux.ts';
import { createApp } from '../app.ts';
import { openDb, runMigrations } from '../db/index.ts';
import { createDomain, type Domain } from '../domain/index.ts';
import { createAiContext } from './index.ts';
import { loadPermissions, savePermissions } from './permissions.ts';
import type { ChatEvent } from './service.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-perm-'));
const { db, sqlite } = openDb(dir);
runMigrations(db);
let d: Domain;
afterAll(() => {
  sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  for (const t of ['change_log', 'outbound_logs', 'outbound_policies', 'ai_sessions'])
    sqlite.exec(`delete from ${t}`);
  d = createDomain(db);
});

async function fauxCtx() {
  const f = await createFauxModel({ simulatePayload: true });
  const ctx = createAiContext(d, dir);
  ctx.resolver.resolve = async (purpose) => ({
    purpose,
    provider: { id: 'deepseek', kind: 'deepseek', label: 'DeepSeek', region: 'domestic' },
    modelId: 'faux',
    model: f.model,
    modelRuntime: f.modelRuntime,
    agentDir: f.agentDir,
  });
  return { ...f, ctx };
}

/** 发给模型的载荷里出现的工具名（载荷格式随提供方变化，按 "name":"xxx" 查） */
const toolNames = (payload: unknown) =>
  [...JSON.stringify(payload).matchAll(/"name":"([a-z_]+)"/g)].map((m) => m[1]);

describe('AI 助手权限', () => {
  it('默认全部开启；保存后读回；未知的项会被拒绝', () => {
    expect(loadPermissions(d)).toEqual({ tools: {}, features: {} });
    savePermissions(d, { tools: { add_follow_up: false }, features: { summary: false } });
    expect(loadPermissions(d)).toEqual({
      tools: { add_follow_up: false },
      features: { summary: false },
    });
    expect(() => savePermissions(d, { tools: { run_sql: true }, features: {} })).toThrow(
      /格式不对/,
    );
  });

  it('关闭的写入/提议工具不提供给模型，系统提示里说明已关闭', async () => {
    savePermissions(d, {
      tools: { add_follow_up: false, propose_delete: false },
      features: {},
    });
    const { ctx, faux, sent } = await fauxCtx();
    faux.setResponses([fauxAssistantMessage(fauxText('好的'))]);
    const events: ChatEvent[] = [];
    await ctx.service.chat({ text: '帮我记一笔跟进', mode: 'extract' }, (e) => events.push(e));
    const names = toolNames(sent[0]);
    expect(names).not.toContain('add_follow_up');
    expect(names).not.toContain('propose_delete');
    expect(names).toContain('create_draft_cooperation');
    expect(names).toContain('propose_update');
    expect(JSON.stringify(sent[0])).toContain('记跟进');
  });

  it('关闭问答模式后，问答请求直接报错，不发给模型', async () => {
    savePermissions(d, { tools: {}, features: { chat: false } });
    const { ctx, sent } = await fauxCtx();
    const events: ChatEvent[] = [];
    await ctx.service.chat({ text: '小美最近怎么样', mode: 'chat' }, (e) => events.push(e));
    expect(events[0]).toMatchObject({ type: 'error', code: 'ai_disabled' });
    expect(sent).toHaveLength(0);
  });

  it('接口：读写权限；关闭摘要/映射/OCR 后对应接口不可用', async () => {
    const app = createApp({ db, sqlite, domain: d, dataDir: dir });
    const call = async (method: string, url: string, body?: unknown) => {
      const res = await app.request(`/api/ai${url}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, json: await res.json() };
    };
    let r = await call('GET', '/permissions');
    expect(r.json.permissions).toEqual({ tools: {}, features: {} });
    expect(r.json.writeTools.add_follow_up).toBe('记跟进');

    r = await call('PUT', '/permissions', {
      tools: {},
      features: { summary: false, mapping: false, ocr: false },
    });
    expect(r.status).toBe(200);
    expect((await call('PUT', '/permissions', { tools: { x: false } })).status).toBe(400);

    r = await call('GET', '/summary');
    expect(r.json).toMatchObject({ available: false, disabled: true });
    r = await call('POST', '/mapping-suggest', { target: 'product', columns: [] });
    expect(r.status).toBe(403);
    expect(r.json.error).toContain('AI 助手 → 权限');
    r = await call('GET', '/ocr/status');
    expect(r.json.enabled).toBe(false);
  });
});

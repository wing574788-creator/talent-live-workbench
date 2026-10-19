import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { openDb, runMigrations } from '../db/index.ts';
import { createDomain } from '../domain/index.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-ai-api-'));
const { db, sqlite } = openDb(dir);
runMigrations(db);
let app: ReturnType<typeof createApp>;

afterAll(() => {
  sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  for (const f of ['ai-config.json', 'secrets.json']) fs.rmSync(path.join(dir, f), { force: true });
  sqlite.exec(
    'delete from outbound_logs; delete from outbound_policies; delete from pending_changes; delete from influencers; delete from change_log',
  );
  app = createApp({ db, sqlite, domain: createDomain(db), dataDir: dir });
});

const call = async (method: string, url: string, body?: unknown) => {
  const res = await app.request(`/api/ai${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: text.startsWith('{') ? JSON.parse(text) : null };
};

const KEY = 'sk-test-0123456789abcdef';

describe('模型配置', () => {
  it('默认没有配置；添加提供方、填 Key、指定用途后可用', async () => {
    let r = await call('GET', '/config');
    expect(r.json.providers).toEqual([]);
    expect(r.json.configured).toBe(false);

    r = await call('PUT', '/providers/deepseek', { kind: 'deepseek', label: 'DeepSeek' });
    expect(r.status).toBe(200);
    expect(r.json.region).toBe('domestic');
    expect(r.json.hasKey).toBe(false);

    r = await call('PUT', '/providers/deepseek/key', { key: KEY });
    expect(r.json).toEqual({ hasKey: true });
    r = await call('PUT', '/purposes/chat', { provider: 'deepseek', model: 'deepseek-flash' });
    expect(r.json.chat).toEqual({ provider: 'deepseek', model: 'deepseek-flash' });
    r = await call('GET', '/config');
    expect(r.json.configured).toBe(true);
    expect(r.json.providers[0].hasKey).toBe(true);
  });

  it('API Key 永远不出现在任何响应里，也不在数据库和配置文件里', async () => {
    await call('PUT', '/providers/deepseek', { kind: 'deepseek', label: 'DeepSeek' });
    await call('PUT', '/providers/deepseek/key', { key: KEY });
    for (const url of ['/config', '/providers/deepseek/models', '/outbound']) {
      const r = await call('GET', url);
      expect(r.text).not.toContain(KEY);
    }
    expect(fs.readFileSync(path.join(dir, 'ai-config.json'), 'utf8')).not.toContain(KEY);
    const dump = sqlite.prepare('select group_concat(after) as a from change_log').get() as {
      a: string | null;
    };
    expect(dump.a ?? '').not.toContain(KEY);
  });

  it('Key 太短 / 提供方不存在 / 兼容接口缺地址：给出提示', async () => {
    await call('PUT', '/providers/deepseek', { kind: 'deepseek', label: 'DeepSeek' });
    expect((await call('PUT', '/providers/deepseek/key', { key: 'abc' })).status).toBe(400);
    expect((await call('PUT', '/providers/nobody/key', { key: KEY })).status).toBe(404);
    const r = await call('PUT', '/providers/qwen', { kind: 'openai-compatible', label: '通义' });
    expect(r.status).toBe(400);
    expect(r.json.error).toContain('接口地址');
  });

  it('兼容接口和 Ollama 的模型取自配置', async () => {
    await call('PUT', '/providers/qwen', {
      kind: 'openai-compatible',
      label: '通义千问',
      baseUrl: 'https://example.invalid/v1',
      models: ['qwen-max'],
    });
    const r = await call('GET', '/providers/qwen/models');
    expect(r.json.models).toEqual([{ id: 'qwen-max', name: 'qwen-max' }]);
    await call('PUT', '/providers/ollama', {
      kind: 'ollama',
      label: '本机',
      baseUrl: 'http://127.0.0.1:11434/v1',
      models: ['llama3'],
    });
    const cfg = await call('GET', '/config');
    expect(cfg.json.providers.find((p: { id: string }) => p.id === 'ollama')).toMatchObject({
      region: 'local',
      hasKey: true,
    });
  });

  it('删除提供方会清掉它的 Key 和用途', async () => {
    await call('PUT', '/providers/deepseek', { kind: 'deepseek', label: 'DeepSeek' });
    await call('PUT', '/providers/deepseek/key', { key: KEY });
    await call('PUT', '/purposes/chat', { provider: 'deepseek', model: 'deepseek-flash' });
    await call('DELETE', '/providers/deepseek');
    const r = await call('GET', '/config');
    expect(r.json.providers).toEqual([]);
    expect(r.json.purposes.chat).toBeNull();
    expect(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8')).not.toContain(KEY);
  });
});

describe('外发规则与日志', () => {
  it('保存规则；未知模块或字段被拒绝', async () => {
    const policy = {
      allowOutbound: true,
      region: 'domestic',
      modules: { shipment: 'deny' },
      fields: { 'cooperation.slotFeeCents': 'mask', 'product.custom.材质': 'allow' },
    };
    let r = await call('PUT', '/outbound', policy);
    expect(r.json.policy).toMatchObject(policy);
    r = await call('GET', '/outbound');
    expect(r.json.policy.region).toBe('domestic');
    expect(r.json.catalog.length).toBe(6);
    expect(
      (await call('PUT', '/outbound', { ...policy, modules: { secret: 'allow' } })).status,
    ).toBe(400);
    expect(
      (await call('PUT', '/outbound', { ...policy, fields: { 'cooperation.phone': 'allow' } }))
        .status,
    ).toBe(400);
    expect((await call('PUT', '/outbound', { allowOutbound: 'yes' })).status).toBe(400);
  });

  it('外发日志可列表、看详情、导出 CSV', async () => {
    const domain = createDomain(db);
    domain.entity('outbound_log').create(domain.userActor(), {
      model: 'deepseek/deepseek-flash',
      module: 'chat',
      payload: '{"text":"[手机号1]"}',
    });
    const list = await call('GET', '/outbound/logs');
    expect(list.json.total).toBe(1);
    expect(list.json.rows[0]).toMatchObject({ model: 'deepseek/deepseek-flash', module: 'chat' });
    const one = await call('GET', `/outbound/logs/${list.json.rows[0].id}`);
    expect(one.json.payload).toContain('[手机号1]');
    const csv = await app.request('/api/ai/outbound/logs/export');
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(await csv.text()).toContain('[手机号1]');
  });
});

describe('对话接口', () => {
  it('没有配置模型时，SSE 里返回友好的错误事件', async () => {
    const res = await app.request('/api/ai/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '你好', mode: 'chat' }),
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const body = await res.text();
    expect(body).toContain('event: error');
    expect(body).toContain('ai_not_configured');
    expect(body).toContain('设置');
  });

  it('审核卡片上改字段：PATCH /review/:id', async () => {
    const domain = createDomain(db);
    const inf = domain.influencers.createWithAccounts(domain.userActor(), {
      influencer: { nickname: '小美' },
      accounts: [],
    }).influencer;
    const res = domain
      .entity('influencer')
      .propose({ ...domain.userActor(), type: 'agent' }, inf.id, { rating: 'A' });
    if (res.status !== 'pending') throw new Error('should be pending');
    const r = await app.request(`/api/review/${res.pendingId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { rating: 'B' } }),
    });
    expect(r.status).toBe(200);
    expect(domain.reviewView.listPending()[0]!.diff[0]).toMatchObject({
      field: 'rating',
      after: 'B',
    });
  });
});

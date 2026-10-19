/**
 * 端到端（不联网）：真实的配置文件 → 模型解析 → Pi 的 OpenAI 兼容提供方 → 本地假接口。
 * 验证真实 HTTP 请求体里已经脱敏、外发日志与实际请求一致、工具调用走通。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDb, runMigrations } from '../db/index.ts';
import { createDomain, type Domain } from '../domain/index.ts';
import { appliedOf } from '../domain/types.ts';
import { createAiContext, type AiContext } from './index.ts';
import { startMockOpenAI, type MockServer } from './mock-openai.ts';
import type { ChatEvent } from './service.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-e2e-'));
const { db, sqlite } = openDb(dir);
runMigrations(db);
let d: Domain;
let mock: MockServer;
let ctx: AiContext;

beforeAll(async () => {
  mock = await startMockOpenAI();
});
afterAll(async () => {
  await mock.close();
  sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  for (const t of [
    'change_log',
    'pending_changes',
    'outbound_logs',
    'outbound_policies',
    'ai_sessions',
    'follow_ups',
    'cooperations',
    'platform_accounts',
    'influencers',
    'contacts',
  ])
    sqlite.exec(`delete from ${t}`);
  d = createDomain(db);
  ctx = createAiContext(d, dir);
  ctx.store.upsertProvider({
    id: 'mock',
    kind: 'openai-compatible',
    label: '本地假接口',
    region: 'local',
    baseUrl: mock.url,
    models: ['mock-1'],
  });
  ctx.store.setKey('mock', 'mock-key-0123456789');
  ctx.store.setPurpose('extract', { provider: 'mock', model: 'mock-1' });
  ctx.store.setPurpose('chat', { provider: 'mock', model: 'mock-1' });
});

const send = async (text: string, extra: Record<string, unknown> = {}) => {
  const events: ChatEvent[] = [];
  await ctx.service.chat(
    { text, mode: 'extract', now: new Date('2026-10-18T04:00:00Z'), ...extra } as never,
    (e) => events.push(e),
  );
  return events;
};

describe('真实提供方通道（本地假接口）', () => {
  it('请求体里是脱敏后的内容；工具调用走通；外发日志与实际请求一致', async () => {
    const r = d.influencers.createWithAccounts(d.userActor(), {
      influencer: { nickname: '小美' },
      accounts: [{ platform: '抖音', accountId: 'xm001' }],
    });
    const coop = appliedOf(
      d.entity('cooperation').create(d.userActor(), {
        influencerId: r.influencer.id,
        platformAccountId: r.accounts[0]!.id,
        stage: '洽谈中',
        nextFollowDate: '2026-10-20',
      }),
    ).row;
    mock.setScript([
      { toolCalls: [{ name: 'find_cooperations', args: { influencerId: r.influencer.id } }] },
      {
        toolCalls: [
          {
            name: 'add_follow_up',
            args: {
              cooperationId: coop.id,
              method: '微信',
              summary: '聊了合作',
              nextFollowDateText: '下周三',
            },
          },
        ],
      },
      { text: '已记录，下次跟进 10月21日 周三。' },
    ]);
    const events = await send('刚和小美聊了，下周三再回复，她手机 13800001111，微信 abc_secret88', {
      confirmed: [coop.id],
    });
    expect(events.at(-1)).toEqual({ type: 'done' });

    // 假接口真的收到了 3 次 HTTP 请求，每次都没有明文手机号和微信
    expect(mock.requests).toHaveLength(3);
    const wire = JSON.stringify(mock.requests);
    expect(wire).not.toContain('13800001111');
    expect(wire).not.toContain('abc_secret88');
    expect(wire).toContain('[手机号1]');
    // 请求里带了工具定义，且只有领域工具（没有 bash 等内置工具）
    const toolNames = (mock.requests[0]!.tools as { function: { name: string } }[]).map(
      (t) => t.function.name,
    );
    expect(toolNames).toContain('add_follow_up');
    expect(toolNames).not.toContain('bash');
    expect(toolNames).not.toContain('read');

    // 外发日志：每次请求一条，内容就是实际发出的内容
    const logs = d.entity('outbound_log').list();
    expect(logs).toHaveLength(3);
    expect(logs.every((l) => l.model === 'mock/mock-1' && l.module === 'extract')).toBe(true);
    expect(logs.map((l) => l.payload).join('')).not.toContain('13800001111');

    // 工具真的执行了
    expect(d.entity('follow_up').list()).toHaveLength(1);
    expect(d.entity('cooperation').require(coop.id).nextFollowDate).toBe('2026-10-21');
    expect(
      events
        .filter((e) => e.type === 'text')
        .map((e) => (e as { delta: string }).delta)
        .join(''),
    ).toContain('10月21日 周三');
  });

  it('API Key 通过请求头发出，但不会出现在请求体、外发日志和会话里', async () => {
    mock.setScript([{ text: '你好' }]);
    await send('你好');
    expect(JSON.stringify(mock.requests)).not.toContain('mock-key-0123456789');
    expect(
      d
        .entity('outbound_log')
        .list()
        .map((l) => l.payload)
        .join(''),
    ).not.toContain('mock-key-0123456789');
    const files = fs
      .readdirSync(dir, { recursive: true })
      .map(String)
      // 数据目录里除了 secrets.json，哪里都不该有 Key（数据库、会话、模型配置、备份……）
      .filter((f) => path.basename(f) !== 'secrets.json');
    for (const f of files) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isFile())
        expect(fs.readFileSync(p, 'utf8')).not.toContain('mock-key-0123456789');
    }
  });

  it('外发配置限定"仅本机"时，境内云端提供方被拒绝，假接口收不到请求', async () => {
    ctx.store.upsertProvider({
      id: 'mock',
      kind: 'openai-compatible',
      label: '境内假接口',
      region: 'domestic',
      baseUrl: mock.url,
      models: ['mock-1'],
    });
    const { savePolicy, defaultPolicy } = await import('./outbound.ts');
    savePolicy(d, { ...defaultPolicy(), region: 'local' });
    mock.setScript([{ text: 'x' }]);
    const before = mock.requests.length;
    const events = await send('你好');
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'outbound_blocked' });
    expect(mock.requests.length).toBe(before);
  });

  it('提供方返回错误时，给出能看懂的提示', async () => {
    mock.setScript([{ status: 401, text: 'Incorrect API key provided' }]);
    const events = await send('你好');
    const last = events.at(-1) as { type: string; message: string };
    expect(last.type).toBe('error');
    expect(last.message).toContain('API Key');
    expect(last.message).not.toContain('sk-mock');
  });
});

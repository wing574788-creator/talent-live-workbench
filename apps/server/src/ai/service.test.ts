import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createFauxModel, fauxAssistantMessage, fauxText, fauxToolCall } from '../agent/faux.ts';
import { openDb, runMigrations } from '../db/index.ts';
import { createDomain, type Domain } from '../domain/index.ts';
import { appliedOf } from '../domain/types.ts';
import { AiConfigStore } from './config.ts';
import { createAiContext, type AiContext } from './index.ts';
import { AiService, type ChatEvent } from './service.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-svc-'));
const { db, sqlite } = openDb(dir);
runMigrations(db);
let d: Domain;
afterAll(() => {
  sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const TABLES = [
  'change_log',
  'pending_changes',
  'outbound_logs',
  'outbound_policies',
  'ai_sessions',
  'follow_ups',
  'cooperation_products',
  'cooperations',
  'platform_accounts',
  'influencers',
  'contacts',
  'products',
];
beforeEach(() => {
  for (const t of TABLES) sqlite.exec(`delete from ${t}`);
  fs.rmSync(path.join(dir, 'ai-sessions'), { recursive: true, force: true });
  d = createDomain(db);
});

const NOW = new Date('2026-10-18T04:00:00Z');

/** 用假模型代替真实模型：配置检查、外发网关、工具、会话全走真实代码 */
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

async function send(ctx: AiContext, req: Parameters<AiService['chat']>[0], signal?: AbortSignal) {
  const events: ChatEvent[] = [];
  await ctx.service.chat({ now: NOW, ...req }, (e) => events.push(e), signal);
  return events;
}

function seed() {
  const inf = d.influencers.createWithAccounts(d.userActor(), {
    influencer: { nickname: '小美' },
    accounts: [{ platform: '抖音', accountId: 'xm001' }],
  });
  const coop = appliedOf(
    d.entity('cooperation').create(d.userActor(), {
      influencerId: inf.influencer.id,
      platformAccountId: inf.accounts[0]!.id,
      stage: '洽谈中',
      nextFollowDate: '2026-10-20',
    }),
  ).row;
  const p = appliedOf(
    d.entity('product').create(d.userActor(), { styleNo: 'A001', name: '针织外套' }),
  ).row;
  const cp = appliedOf(
    d
      .entity('cooperation_product')
      .create(d.userActor(), { cooperationId: coop.id, productId: p.id, commissionPct: 20 }),
  ).row;
  const contact = appliedOf(
    d.entity('contact').create(d.userActor(), {
      name: '李经纪',
      type: '经纪人',
      wechat: 'secret_wx_88',
      phone: '13800001111',
    }),
  ).row;
  d.influencers.linkContact(d.userActor(), inf.influencer.id, contact.id, true);
  return { inf: inf.influencer, coop, cp, p };
}

describe('AI 会话服务', () => {
  it('没有配置模型：友好提示，不发任何请求', async () => {
    const ctx = createAiContext(d, fs.mkdtempSync(path.join(os.tmpdir(), 'wb-empty-')));
    const events = await send(ctx, { text: '你好', mode: 'chat' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', code: 'ai_not_configured' });
    expect((events[0] as { message: string }).message).toContain('设置 → 模型');
    expect(d.entity('outbound_log').list()).toHaveLength(0);
  });

  it('提供方没填 Key 时给出明确提示', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-nokey-'));
    const store = new AiConfigStore(tmp);
    store.upsertProvider({
      id: 'deepseek',
      kind: 'deepseek',
      label: 'DeepSeek',
      region: 'domestic',
    });
    store.setPurpose('extract', { provider: 'deepseek', model: 'deepseek-flash' });
    const ctx = createAiContext(d, tmp);
    const events = await send(ctx, { text: '你好', mode: 'extract' });
    expect((events[0] as { message: string }).message).toContain('还没有填写 API Key');
  });

  it('一句话录入：查询 → 记跟进（直接写入）→ 改佣金（待审核）；脱敏、日志、回显记录齐全', async () => {
    const { inf, coop, cp } = seed();
    const { ctx, faux, sent } = await fauxCtx();
    const text = '刚和小美聊了，佣金 25 个点，下周三再回复我，微信 13800001111';
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('find_cooperations', { influencerId: inf.id })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage(
        [
          fauxToolCall('add_follow_up', {
            cooperationId: coop.id,
            method: '微信',
            summary: '聊了佣金，对方下周三回复',
            followStatus: '待回复',
            nextFollowDateText: '下周三',
          }),
          fauxToolCall('propose_update', {
            entity: 'cooperation_product',
            id: cp.id,
            patch: { commissionPct: 25 },
            quotes: { commissionPct: '佣金 25 个点' },
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage(
        fauxText('已记录这次跟进，下次跟进 10月21日 周三；佣金改为 25% 已生成待审核卡片。'),
      ),
    ]);
    const events = await send(ctx, { text, mode: 'extract', confirmed: [coop.id] });

    expect(events[0]!.type).toBe('session');
    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(
      events
        .filter((e) => e.type === 'tool')
        .map(
          (e) => (e as { name: string; state: string }).name + ':' + (e as { state: string }).state,
        ),
    ).toEqual(
      expect.arrayContaining([
        'find_cooperations:start',
        'find_cooperations:end',
        'add_follow_up:end',
        'propose_update:end',
      ]),
    );
    const cards = events
      .filter((e) => e.type === 'card')
      .map((e) => (e as { card: { kind: string } }).card);
    expect(cards.map((c) => c.kind).sort()).toEqual(['applied', 'pending']);

    // 数据：跟进直接写入，佣金没有变（待审核）
    expect(d.entity('follow_up').list()).toHaveLength(1);
    expect(d.entity('cooperation_product').require(cp.id).commissionPct).toBe(20);
    expect(
      sqlite.prepare("select count(*) as n from pending_changes where status='pending'").get(),
    ).toEqual({ n: 1 });
    // 同一批次：审核页上能看到来源
    const pend = d.reviewView.listPending()[0]!;
    expect(pend.source).toContain('佣金 25 个点');
    expect(pend.actorType).toBe('agent');

    // 外发：每次请求都记日志，且发出去的内容里没有手机号
    const logs = d.entity('outbound_log').list();
    expect(logs).toHaveLength(3);
    expect(logs.every((l) => l.model === 'deepseek/faux' && l.module === 'extract')).toBe(true);
    const everything = JSON.stringify(sent) + logs.map((l) => l.payload).join('');
    expect(everything).not.toContain('13800001111');
    expect(everything).not.toContain('secret_wx_88');
    expect(everything).toContain('[手机号1]');

    // 会话回显记录
    const sessionId = (events[0] as { sessionId: string }).sessionId;
    const saved = ctx.service.getSession(sessionId);
    const tr = saved.transcript as { role: string; text: string; cards?: unknown[] }[];
    expect(tr.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(tr[1]!.text).toContain('10月21日 周三');
    expect(tr[1]!.cards).toHaveLength(2);
    expect(saved.file).toMatch(/^ai-sessions[\\/]/);
    expect(fs.existsSync(path.join(dir, saved.file!))).toBe(true);
  });

  it('同一会话里继续对话：上一轮的内容带着走', async () => {
    seed();
    const { ctx, faux, sent } = await fauxCtx();
    faux.setResponses([
      fauxAssistantMessage(fauxText('收到，我记住了：小美喜欢纯佣。')),
      fauxAssistantMessage(fauxText('她喜欢纯佣。')),
    ]);
    const first = await send(ctx, { text: '小美喜欢纯佣', mode: 'chat' });
    const sessionId = (first[0] as { sessionId: string }).sessionId;
    await send(ctx, { sessionId, text: '她喜欢什么合作方式？', mode: 'chat' });
    const second = JSON.stringify(sent.at(-1));
    expect(second).toContain('小美喜欢纯佣');
    expect(second).toContain('她喜欢什么合作方式');
    expect((ctx.service.getSession(sessionId).transcript as unknown[]).length).toBe(4);
  });

  it('问答模式只有查询工具：写入工具即使被模型调用也不会执行', async () => {
    const { inf, coop } = seed();
    const { ctx, faux } = await fauxCtx();
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('add_follow_up', { cooperationId: coop.id, method: '微信', summary: 'x' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage(fauxText('我不能修改数据。')),
    ]);
    const events = await send(ctx, {
      text: '帮我记一条跟进',
      mode: 'chat',
      confirmed: [coop.id, inf.id],
    });
    expect(d.entity('follow_up').list()).toHaveLength(0);
    expect(events.some((e) => e.type === 'tool' && e.state === 'error')).toBe(true);
  });

  it('外发设置禁止云端模型时，请求在发出前被拒绝', async () => {
    seed();
    const { savePolicy, defaultPolicy } = await import('./outbound.ts');
    savePolicy(d, { ...defaultPolicy(), allowOutbound: false });
    const { ctx, sent } = await fauxCtx();
    const events = await send(ctx, { text: '你好', mode: 'chat' });
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'outbound_blocked' });
    expect(sent).toHaveLength(0);
    expect(d.entity('outbound_log').list()).toHaveLength(0);
  });

  it('侧栏选中的记录告诉模型，并作为已确认目标', async () => {
    const { inf } = seed();
    d.entity('influencer').create(d.userActor(), { nickname: '小美美' });
    const { ctx, faux, sent } = await fauxCtx();
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('add_follow_up', {
            influencerId: inf.id,
            method: '电话',
            summary: '通了电话',
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage(fauxText('好的')),
    ]);
    await send(ctx, {
      text: '刚和她通了电话',
      mode: 'extract',
      context: { page: '达人库', selected: { type: 'influencer', id: inf.id } },
    });
    expect(d.entity('follow_up').list()).toHaveLength(1);
    expect(JSON.stringify(sent[0])).toContain(inf.id);
  });
});

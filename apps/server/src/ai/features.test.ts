import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createFauxModel, fauxAssistantMessage, fauxText } from '../agent/faux.ts';
import { openDb, runMigrations } from '../db/index.ts';
import { createDomain, type Domain } from '../domain/index.ts';
import { appliedOf } from '../domain/types.ts';
import { createAiContext } from './index.ts';
import { suggestMappingWithAi } from './mapping.ts';
import { defaultPolicy, savePolicy } from './outbound.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-feat-'));
const { db, sqlite } = openDb(dir);
runMigrations(db);
let d: Domain;
afterAll(() => {
  sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  for (const t of [
    'change_log',
    'summary_cache',
    'outbound_logs',
    'outbound_policies',
    'follow_ups',
    'cooperations',
    'platform_accounts',
    'influencers',
    'contacts',
  ])
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

function seedOverdue() {
  const r = d.influencers.createWithAccounts(d.userActor(), {
    influencer: { nickname: '小美' },
    accounts: [{ platform: '抖音', accountId: 'xm001' }],
  });
  const c = appliedOf(
    d.entity('cooperation').create(d.userActor(), {
      influencerId: r.influencer.id,
      platformAccountId: r.accounts[0]!.id,
      stage: '洽谈中',
      nextFollowDate: '2020-01-01',
    }),
  ).row;
  const contact = appliedOf(
    d.entity('contact').create(d.userActor(), {
      name: '李经纪',
      type: '经纪人',
      wechat: 'secret_wx_88',
      phone: '13800001111',
    }),
  ).row;
  d.influencers.linkContact(d.userActor(), r.influencer.id, contact.id, true);
  return { inf: r.influencer, coop: c };
}

describe('首页 AI 摘要', () => {
  it('生成一次后按天缓存；重新生成才会再请求模型；发给模型的快照不含手机微信', async () => {
    const { inf, coop } = seedOverdue();
    const { ctx, faux, sent } = await fauxCtx();
    faux.setResponses([
      fauxAssistantMessage(fauxText(`- [小美](wb:influencer:${inf.id}) 的跟进已逾期。`)),
      fauxAssistantMessage(fauxText('- 第二次生成。')),
    ]);
    const first = await ctx.summary.get('2026-10-18');
    expect(first.cached).toBe(false);
    expect(first.content).toContain('已逾期');
    const again = await ctx.summary.get('2026-10-18');
    expect(again).toMatchObject({ cached: true, content: first.content });
    expect(sent).toHaveLength(1);
    // 换一天要重新生成
    const refreshed = await ctx.summary.get('2026-10-18', true);
    expect(refreshed.content).toBe('- 第二次生成。');
    expect(sent).toHaveLength(2);
    // 快照里是昵称和链接，没有手机、微信
    const all = JSON.stringify(sent);
    expect(all).toContain('小美');
    expect(all).toContain(`wb:cooperation:${coop.id}`);
    expect(all).not.toContain('13800001111');
    expect(all).not.toContain('secret_wx_88');
    expect(
      d
        .entity('outbound_log')
        .list()
        .every((l) => l.module === 'summary'),
    ).toBe(true);
  });

  it('外发设置禁止合作模块：快照里没有合作数据', async () => {
    seedOverdue();
    savePolicy(d, { ...defaultPolicy(), modules: { cooperation: 'deny' } });
    const { ctx } = await fauxCtx();
    const snap = ctx.summary.snapshot('2026-10-18');
    expect(snap).not.toHaveProperty('dueFollows');
    expect(snap).not.toHaveProperty('upcomingLives');
  });

  it('昵称字段设置为不外发时，快照里是 [已隐藏]', async () => {
    seedOverdue();
    savePolicy(d, { ...defaultPolicy(), fields: { 'influencer.nickname': 'deny' } });
    const { ctx } = await fauxCtx();
    expect(JSON.stringify(ctx.summary.snapshot('2026-10-18'))).not.toContain('小美');
  });

  it('接口：没配置模型时 available = false', async () => {
    const { createApp } = await import('../app.ts');
    const app = createApp({
      db,
      sqlite,
      domain: d,
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wb-empty-')),
    });
    const res = await (await app.request('/api/ai/summary')).json();
    expect(res.available).toBe(false);
    expect(res.message).toContain('AI 助手 → 模型');
  });
});

describe('导入映射建议', () => {
  const col = (index: number, name: string, ...samples: string[]) => ({ index, name, samples });

  it('规则拿不准的列交给模型补充；模型给的非法字段、重复字段被丢弃', async () => {
    const { ctx, faux, sent } = await fauxCtx();
    faux.setResponses([
      fauxAssistantMessage(
        fauxText(
          '[{"columnIndex":2,"field":"followers","confidence":0.9},{"columnIndex":3,"field":"不存在的字段","confidence":0.9},{"columnIndex":4,"field":"followers","confidence":0.6}]',
        ),
      ),
    ]);
    const columns = [
      col(0, '达人昵称', '小美'),
      col(1, '平台', '抖音'),
      col(2, '关注者数量', '12.5w'),
      col(3, '杂项', 'abc'),
      col(4, '另一列', '1000'),
    ];
    const res = await suggestMappingWithAi(ctx, { target: 'influencer', columns });
    expect(res.source).toBe('ai');
    const by = (i: number) => res.suggestions.find((s) => s.columnIndex === i)!;
    expect(by(0)).toMatchObject({ source: 'rules', mapping: { kind: 'field', field: 'nickname' } });
    expect(by(2)).toMatchObject({
      source: 'ai',
      mapping: { kind: 'field', field: 'followers' },
      confidence: 0.85,
    });
    expect(by(3).mapping.kind).toBe('ignore');
    expect(by(4).mapping.kind).toBe('ignore'); // followers 已被置信度更高的一列占用
    // 只发了待判断的列，没有发规则已经对上的列
    const payload = JSON.stringify(sent);
    expect(payload).toContain('关注者数量');
    expect(payload).not.toContain('达人昵称');
  });

  it('表头全部对得上：不请求模型', async () => {
    const { ctx, sent } = await fauxCtx();
    const res = await suggestMappingWithAi(ctx, {
      target: 'influencer',
      columns: [col(0, '达人昵称'), col(1, '平台')],
    });
    expect(res.source).toBe('rules');
    expect(sent).toHaveLength(0);
  });

  it('没配置模型 / 回答格式不对：回退到规则建议并说明原因', async () => {
    const empty = createAiContext(d, fs.mkdtempSync(path.join(os.tmpdir(), 'wb-empty-')));
    const columns = [col(0, '达人昵称'), col(1, '杂项', 'abc')];
    const r1 = await suggestMappingWithAi(empty, { target: 'influencer', columns });
    expect(r1.source).toBe('rules');
    expect(r1.message).toContain('规则建议');
    const { ctx, faux } = await fauxCtx();
    faux.setResponses([fauxAssistantMessage(fauxText('我觉得第二列是备注。'))]);
    const r2 = await suggestMappingWithAi(ctx, { target: 'influencer', columns });
    expect(r2).toMatchObject({ source: 'rules', message: expect.stringContaining('格式不对') });
  });

  it('样本里的手机号在发出前被脱敏', async () => {
    const { ctx, faux, sent } = await fauxCtx();
    faux.setResponses([fauxAssistantMessage(fauxText('[]'))]);
    await suggestMappingWithAi(ctx, {
      target: 'contact',
      columns: [col(0, '姓名'), col(1, '联系方式', '13900002222', '13900003333')],
    });
    expect(JSON.stringify(sent)).not.toContain('13900002222');
    expect(JSON.stringify(sent)).toContain('[手机号');
  });
});

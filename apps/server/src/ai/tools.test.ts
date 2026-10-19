import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { openDb, runMigrations } from '../db/index.ts';
import { createDomain, type Domain } from '../domain/index.ts';
import { appliedOf, type Row } from '../domain/types.ts';
import { OutboundGuard, defaultPolicy, savePolicy } from './outbound.ts';
import { AiRun, type Card, type RunOptions } from './run.ts';
import { buildTools } from './tools.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-tools-'));
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
  'outbound_policies',
  'cooperation_products',
  'cooperations',
  'follow_ups',
  'sample_shipment_items',
  'sample_shipments',
  'influencer_contacts',
  'platform_accounts',
  'influencers',
  'contacts',
  'product_variants',
  'products',
];
beforeEach(() => {
  for (const t of TABLES) sqlite.exec(`delete from ${t}`);
  d = createDomain(db);
});

/** 北京时间 2026-10-18 周日 */
const NOW = new Date('2026-10-18T04:00:00Z');

function setup(originalText: string, opts: Partial<RunOptions> = {}) {
  const cards: Card[] = [];
  const run = new AiRun(d, new OutboundGuard(d), {
    originalText,
    now: NOW,
    emit: (c) => cards.push(c),
    ...opts,
  });
  const tools = new Map(buildTools(run).map((t) => [t.name, t]));
  const call = (name: string, params: Record<string, unknown> = {}) =>
    tools.get(name)!.execute(params) as Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  return { run, cards, call, tools };
}

function influencer(nickname: string, accountId: string) {
  const r = d.influencers.createWithAccounts(d.userActor(), {
    influencer: { nickname },
    accounts: [{ platform: '抖音', accountId }],
  });
  return { inf: r.influencer, account: r.accounts[0]! };
}
function cooperation(inf: Row, account: Row, extra: Record<string, unknown> = {}) {
  return appliedOf(
    d.entity('cooperation').create(d.userActor(), {
      influencerId: inf.id,
      platformAccountId: account.id,
      stage: '待建联',
      ...extra,
    }),
  ).row;
}
function product(styleNo: string, name: string, colors: string[], sizes: string[]) {
  const p = appliedOf(d.entity('product').create(d.userActor(), { styleNo, name })).row;
  for (const color of colors)
    for (const size of sizes)
      d.entity('product_variant').create(d.userActor(), { productId: p.id, color, size });
  return p;
}
const pendingCount = () =>
  d.entity('cooperation').list().length &&
  (
    sqlite.prepare("select count(*) as n from pending_changes where status='pending'").get() as {
      n: number;
    }
  ).n;

describe('只读工具', () => {
  it('当前时间和日期解析由程序完成', async () => {
    const { call } = setup('');
    expect((await call('get_current_time')).display).toBe('10月18日 周日 12:00');
    expect((await call('resolve_date', { text: '下周三' })).display).toBe('10月21日 周三');
    await expect(call('resolve_date', { text: '尽快' })).rejects.toThrow(/无法解析/);
  });

  it('搜索达人：唯一匹配 / 多个匹配', async () => {
    influencer('小美', 'xm001');
    influencer('小美美', 'xm002');
    influencer('阿杰', 'aj001');
    const { call } = setup('');
    expect((await call('find_influencers', { query: '阿杰' })).matches).toBe(1);
    const r = await call('find_influencers', { query: '小美' });
    expect(r.matches).toBe(2);
    expect(r.rows[0].ref.link).toMatch(/^wb:influencer:/);
  });

  it('返回给模型的结果里没有手机号、微信号、地址、真实姓名', async () => {
    const { inf } = influencer('小美', 'xm001');
    d.entity('influencer').update(d.userActor(), inf.id, { realName: '王小美' });
    const c = appliedOf(
      d.entity('contact').create(d.userActor(), {
        name: '李经纪',
        type: '经纪人',
        org: '星光传媒',
        wechat: 'secret_wx_88',
        phone: '13800001111',
      }),
    ).row;
    d.influencers.linkContact(d.userActor(), inf.id, c.id, true);
    const { call } = setup('');
    const all = JSON.stringify([
      await call('get_influencer', { id: inf.id }),
      await call('find_contacts', { query: '李' }),
      await call('run_stats', { name: 'influencers_of_org', org: '星光' }),
    ]);
    for (const secret of ['secret_wx_88', '13800001111', '王小美'])
      expect(all).not.toContain(secret);
    expect(all).toContain('李经纪');
    expect(all).toContain('小美');
  });

  it('外发规则禁止的模块查不了；禁止的字段不返回', async () => {
    const { inf } = influencer('小美', 'xm001');
    d.entity('influencer').update(d.userActor(), inf.id, {
      rating: 'S',
      coopPreference: '只做纯佣',
    });
    savePolicy(d, {
      ...defaultPolicy(),
      modules: { cooperation: 'deny' },
      fields: { 'influencer.rating': 'deny', 'influencer.coopPreference': 'mask' },
    });
    const { call } = setup('');
    await expect(call('find_cooperations', {})).rejects.toThrow(/不允许发给模型/);
    const r = await call('get_influencer', { id: inf.id });
    expect(r.rating).toBeUndefined();
    expect(r.coopPreference).toBe('[已隐藏]');
  });

  it('统计：签收超过 N 天未开播、逾期样衣', async () => {
    const { inf, account } = influencer('小美', 'xm001');
    const coop = cooperation(inf, account, { stage: '待寄样' });
    const p = product('A001', '针织外套', ['米白'], ['S']);
    const ship = d.samples.createShipment(d.userActor(), {
      influencerId: inf.id,
      cooperationId: coop.id,
      items: [{ productId: p.id, color: '米白', size: 'S', qty: 2 }],
    });
    d.samples.ship(d.userActor(), ship.id, {
      shippedAt: '2026-09-20',
      recipient: '收件人',
      phone: '13900002222',
      address: '浙江省杭州市余杭区文一西路969号',
    });
    d.samples.sign(d.userActor(), ship.id, '2026-09-25');
    const { call } = setup('');
    const r = await call('run_stats', { name: 'signed_not_live', minDays: 14 });
    expect(r.count).toBe(1);
    expect(r.rows[0]).toMatchObject({ nickname: '小美', days: 23, outstanding: 2 });
    expect((await call('run_stats', { name: 'signed_not_live', minDays: 30 })).count).toBe(0);
    const bal = await call('get_sample_balance', { influencerId: inf.id });
    expect(bal.lines[0]).toMatchObject({
      styleNo: 'A001',
      productName: '针织外套',
      color: '米白',
      size: 'S',
      outstanding: 2,
    });
    expect(JSON.stringify(bal)).not.toContain('13900002222');
  });
});

describe('目标确认与一次一个合作', () => {
  it('唯一匹配的达人可以直接写；记录里带出处原文，操作者是 AI', async () => {
    const { inf, account } = influencer('阿杰', 'aj001');
    const coop = cooperation(inf, account, { stage: '洽谈中', nextFollowDate: '2026-10-20' });
    const text = '刚和阿杰聊了，他说下周三再给答复';
    const { call, cards } = setup(text);
    await call('find_cooperations', { influencerId: inf.id });
    const r = await call('add_follow_up', {
      cooperationId: coop.id,
      method: '微信',
      summary: '聊了合作，对方下周三答复',
      followStatus: '待回复',
      nextFollowDateText: '下周三',
    });
    expect(r.nextFollowDate.display).toBe('10月21日 周三');
    const row = d.entity('follow_up').list()[0]!;
    expect(row).toMatchObject({
      cooperationId: coop.id,
      sourceText: text,
      nextFollowDate: '2026-10-21',
    });
    const log = sqlite
      .prepare("select actor_type, source, batch_id from change_log where entity='follow_up'")
      .get() as { actor_type: string; source: string; batch_id: string };
    expect(log.actor_type).toBe('agent');
    expect(log.source).toContain('刚和阿杰聊了');
    expect(cards[0]).toMatchObject({ kind: 'applied', entity: 'follow_up' });
    expect(cards[0]!.lines).toContain('下次跟进：10月21日 周三');
    // 合作上的下次跟进日期被同步
    expect(d.entity('cooperation').require(coop.id).nextFollowDate).toBe('2026-10-21');
  });

  it('同名候选有多个时，不允许自动选；让用户选之后才能写', async () => {
    const a = influencer('小美', 'xm001');
    const b = influencer('小美美', 'xm002');
    const { call, cards } = setup('小美今天回复了');
    await call('find_influencers', { query: '小美' });
    await expect(
      call('add_follow_up', { influencerId: a.inf.id, method: '微信', summary: '回复了' }),
    ).rejects.toThrow(/不能自动选择/);
    await call('ask_user_to_choose', {
      question: '是哪一位小美？',
      entity: 'influencer',
      ids: [a.inf.id, b.inf.id],
    });
    expect(cards.at(-1)).toMatchObject({ kind: 'choose' });
    expect(cards.at(-1)!.candidates).toHaveLength(2);
    // 提问之后本轮不能再写
    await expect(
      call('add_follow_up', { influencerId: a.inf.id, method: '微信', summary: '回复了' }),
    ).rejects.toThrow(/已经请用户选择/);
    expect(d.entity('follow_up').list()).toHaveLength(0);

    // 用户选定 b 之后的新一轮
    const next = setup('选了小美美', { confirmed: [b.inf.id] });
    await next.call('add_follow_up', { influencerId: b.inf.id, method: '微信', summary: '回复了' });
    expect(d.entity('follow_up').list()).toHaveLength(1);
    await expect(
      next.call('add_follow_up', { influencerId: a.inf.id, method: '微信', summary: '回复了' }),
    ).rejects.toThrow(/不是本轮查询到的记录|不能自动选择/);
  });

  it('模型编造的 ID 不能写', async () => {
    const { call } = setup('x');
    await expect(
      call('add_follow_up', { influencerId: 'nope', method: '微信', summary: 'x' }),
    ).rejects.toThrow(/不存在/);
  });

  it('侧栏当前选中的记录视为用户已确认', async () => {
    const a = influencer('小美', 'xm001');
    influencer('小美美', 'xm002');
    const { call } = setup('回复了', {
      context: { selected: { type: 'influencer', id: a.inf.id } },
    });
    await call('add_follow_up', { influencerId: a.inf.id, method: '微信', summary: '回复了' });
    expect(d.entity('follow_up').list()).toHaveLength(1);
  });

  it('一次录入只写一个合作', async () => {
    const { inf, account } = influencer('阿杰', 'aj001');
    const c1 = cooperation(inf, account);
    const c2 = cooperation(inf, account);
    const { call } = setup('阿杰两个合作都聊了');
    await call('find_cooperations', { influencerId: inf.id });
    // 两个合作 → 各自都是"多个候选之一"
    await expect(
      call('add_follow_up', { cooperationId: c1.id, method: '微信', summary: 'x' }),
    ).rejects.toThrow(/不能自动选择/);
    const ok = setup('阿杰两个合作都聊了', { confirmed: [c1.id, c2.id] });
    await ok.call('add_follow_up', { cooperationId: c1.id, method: '微信', summary: 'x' });
    await expect(
      ok.call('add_follow_up', { cooperationId: c2.id, method: '微信', summary: 'y' }),
    ).rejects.toThrow(/只能写一个合作/);
    expect(d.entity('follow_up').list()).toHaveLength(1);
  });
});

describe('日期、金额、佣金护栏', () => {
  async function coopSetup(text: string) {
    const { inf, account } = influencer('小美', 'xm001');
    d.entity('influencer').update(d.userActor(), inf.id, { refCommissionPct: 20 });
    const coop = cooperation(inf, account, { stage: '已确认' });
    const p = product('A001', '针织外套', ['米白'], ['S', 'M']);
    const cp = appliedOf(
      d
        .entity('cooperation_product')
        .create(d.userActor(), { cooperationId: coop.id, productId: p.id, commissionPct: 20 }),
    ).row;
    const s = setup(text, { confirmed: [coop.id, inf.id] });
    return { ...s, inf, coop, cp, p };
  }

  it('佣金和原文一致：生成待审核，记录本身不变', async () => {
    const { call, cards, cp } = await coopSetup('小美的经纪人说佣金 25 个点');
    const r = await call('propose_update', {
      entity: 'cooperation_product',
      id: cp.id,
      patch: { commissionPct: 25 },
      quotes: { commissionPct: '佣金 25 个点' },
    });
    expect(r.status).toBe('pending');
    expect(d.entity('cooperation_product').require(cp.id).commissionPct).toBe(20);
    expect(cards[0]).toMatchObject({ kind: 'pending', entity: 'cooperation_product' });
    expect(pendingCount()).toBe(1);
  });

  it('佣金和原文对不上、没有单位、出处不在原文里：全部拒绝，不产生待审核', async () => {
    const { call, cp } = await coopSetup('小美的经纪人说佣金 25 个点');
    await expect(
      call('propose_update', {
        entity: 'cooperation_product',
        id: cp.id,
        patch: { commissionPct: 30 },
        quotes: { commissionPct: '佣金 25 个点' },
      }),
    ).rejects.toThrow(/数值和原文对不上/);
    await expect(
      call('propose_update', {
        entity: 'cooperation_product',
        id: cp.id,
        patch: { commissionPct: 25 },
      }),
    ).rejects.toThrow(/缺少原文出处/);
    await expect(
      call('propose_update', {
        entity: 'cooperation_product',
        id: cp.id,
        patch: { commissionPct: 25 },
        quotes: { commissionPct: '佣金 25%' },
      }),
    ).rejects.toThrow(/不在用户的原文里/);
    expect(pendingCount()).toBe(0);
  });

  it('金额：1.2万 → 1200000 分才对；1200 元不对', async () => {
    const { call, coop } = await coopSetup('坑位费 1.2万');
    await expect(
      call('propose_update', {
        entity: 'cooperation',
        id: coop.id,
        patch: { slotFeeCents: 120000 },
        quotes: { slotFeeCents: '坑位费 1.2万' },
      }),
    ).rejects.toThrow(/对不上/);
    await call('propose_update', {
      entity: 'cooperation',
      id: coop.id,
      patch: { slotFeeCents: 1200000 },
      quotes: { slotFeeCents: '坑位费 1.2万' },
    });
    expect(pendingCount()).toBe(1);
  });

  it('异常佣金：超过 50% 或明显偏离历史值，卡片带警告', async () => {
    const { call, cards, cp } = await coopSetup('佣金 60%');
    const r = await call('propose_update', {
      entity: 'cooperation_product',
      id: cp.id,
      patch: { commissionPct: 60 },
      quotes: { commissionPct: '佣金 60%' },
    });
    expect(r.warnings.join()).toContain('超过 50%');
    expect(r.warnings.join()).toContain('偏离');
    expect(cards[0]!.warnings!.length).toBe(2);
    const stored = sqlite.prepare('select warnings from pending_changes').get() as {
      warnings: string;
    };
    expect(JSON.parse(stored.warnings)).toHaveLength(2);
  });

  it('日期：说法由程序解析并回显；说法不在原话里、模型自己给日期都拒绝', async () => {
    const { call, coop } = await coopSetup('小美下周三播');
    await expect(
      call('propose_update', {
        entity: 'cooperation',
        id: coop.id,
        patch: { liveDate: '2026-10-21' },
      }),
    ).rejects.toThrow(/不能直接给值/);
    await expect(
      call('propose_update', {
        entity: 'cooperation',
        id: coop.id,
        patch: {},
        dateTexts: { liveDate: '下周五' },
      }),
    ).rejects.toThrow(/不在用户的原话里/);
    const r = await call('propose_update', {
      entity: 'cooperation',
      id: coop.id,
      patch: {},
      dateTexts: { liveDate: '下周三' },
    }).catch((e: Error) => e);
    // patch 为空但有 dateTexts：合法
    expect((r as { status: string }).status).toBe('pending');
    expect((r as { resolvedDates: string[] }).resolvedDates).toEqual(['liveDate：10月21日 周三']);
    const p = sqlite.prepare('select patch from pending_changes').get() as { patch: string };
    expect(JSON.parse(p.patch)).toEqual({ liveDate: '2026-10-21' });
  });

  it('占位符、白名单之外的字段（手机号、微信、真实姓名）拒绝', async () => {
    const { call, inf } = await coopSetup('小美的新微信是 [微信号1]');
    await expect(
      call('propose_update', {
        entity: 'influencer',
        id: inf.id,
        patch: { coopPreference: '联系 [微信号1]' },
      }),
    ).rejects.toThrow(/占位符/);
    await expect(
      call('propose_update', { entity: 'influencer', id: inf.id, patch: { realName: '王小美' } }),
    ).rejects.toThrow(/不能由 AI 修改/);
    await expect(
      call('propose_update', { entity: 'contact', id: inf.id, patch: { wechat: 'abc' } }),
    ).rejects.toThrow();
    expect(pendingCount()).toBe(0);
  });
});

describe('低风险写：草稿合作、寄样草稿', () => {
  it('新建草稿合作：佣金核对通过后直接写入，同一批次可整批撤销', async () => {
    const { inf } = influencer('小美', 'xm001');
    const p = product('A001', '针织外套', ['米白'], ['S']);
    const { call, cards } = setup('小美想合作 A001，佣金 25 个点，下周三播', {
      confirmed: [inf.id],
    });
    await call('find_products', { query: 'A001' });
    const r = await call('create_draft_cooperation', {
      influencerId: inf.id,
      products: [{ productId: p.id, commissionPct: 25, commissionQuote: '佣金 25 个点' }],
      liveDateText: '下周三',
    });
    expect(r.liveDate.date).toBe('2026-10-21');
    const coop = d.entity('cooperation').list()[0]!;
    expect(coop).toMatchObject({ stage: '待建联', liveDate: '2026-10-21' });
    expect(d.entity('cooperation_product').list()[0]).toMatchObject({ commissionPct: 25 });
    const undone = d.review.undoBatch(d.userActor(), cards[0]!.batchId!);
    expect(undone).toBeTruthy();
    expect(d.entity('cooperation').list()).toHaveLength(0);
  });

  it('已有进行中的合作时默认拒绝新建', async () => {
    const { inf, account } = influencer('小美', 'xm001');
    cooperation(inf, account, { stage: '洽谈中', nextFollowDate: '2026-10-20' });
    const { call } = setup('x', { confirmed: [inf.id] });
    await expect(call('create_draft_cooperation', { influencerId: inf.id })).rejects.toThrow(
      /已有 1 个进行中的合作/,
    );
    await call('create_draft_cooperation', { influencerId: inf.id, forceNew: true });
    expect(d.entity('cooperation').list()).toHaveLength(2);
  });

  it('寄样草稿：只是待寄样，不计入在外；颜色尺码不存在时报错并列出可选', async () => {
    const { inf, account } = influencer('小美', 'xm001');
    const coop = cooperation(inf, account);
    product('A001', '针织外套', ['米白', '黑'], ['S', 'M']);
    const { call, cards } = setup('样衣明天寄 S、M 各一件', { confirmed: [inf.id, coop.id] });
    await expect(
      call('create_sample_shipment_draft', {
        influencerId: inf.id,
        cooperationId: coop.id,
        items: [{ styleNo: 'A001', color: '红', size: 'S', qty: 1 }],
      }),
    ).rejects.toThrow(/没有「红 S」，可选：.*米白 S.*黑 M/);
    await expect(
      call('create_sample_shipment_draft', {
        influencerId: inf.id,
        items: [{ styleNo: 'Z999', color: '黑', size: 'S', qty: 1 }],
      }),
    ).rejects.toThrow(/没有款号/);
    const r = await call('create_sample_shipment_draft', {
      influencerId: inf.id,
      cooperationId: coop.id,
      items: [
        { styleNo: 'A001', color: '米白', size: 'S', qty: 1 },
        { styleNo: 'A001', color: '米白', size: 'M', qty: 1 },
      ],
    });
    expect(r.status).toBe('待寄样');
    expect(d.entity('sample_shipment').list()[0]).toMatchObject({
      status: '待寄样',
      influencerId: inf.id,
    });
    expect(d.entity('sample_shipment_item').list()).toHaveLength(2);
    expect(cards[0]!.lines![0]).toBe('A001 针织外套 米白 S ×1');
    const { call: call2 } = setup('');
    expect((await call2('get_sample_balance', { influencerId: inf.id })).lines).toEqual([]);
  });
});

describe('敏感写：只生成待审核', () => {
  it('改阶段、合并、删除都只生成待审核，数据不变', async () => {
    const a = influencer('小美', 'xm001');
    const b = influencer('小美美', 'xm002');
    const coop = cooperation(a.inf, a.account, { stage: '已确认' });
    const { call } = setup('x', { confirmed: [a.inf.id, b.inf.id, coop.id] });
    expect(
      (await call('propose_stage_change', { cooperationId: coop.id, stage: '待寄样' })).status,
    ).toBe('pending');
    expect(d.entity('cooperation').require(coop.id).stage).toBe('已确认');
    expect(
      (await call('propose_merge_influencers', { keepId: a.inf.id, mergeId: b.inf.id })).status,
    ).toBe('pending');
    expect(d.entity('influencer').list()).toHaveLength(2);
    expect((await call('propose_delete', { entity: 'influencer', id: b.inf.id })).status).toBe(
      'pending',
    );
    expect(d.entity('influencer').list()).toHaveLength(2);
    expect(pendingCount()).toBe(3);
    // 审核通过后才生效
    const ids = (
      sqlite.prepare("select id from pending_changes where entity='cooperation'").all() as {
        id: string;
      }[]
    ).map((x) => x.id);
    d.review.approve(ids[0]!, d.userId);
    expect(d.entity('cooperation').require(coop.id).stage).toBe('待寄样');
  });

  it('改到洽谈中缺下次跟进日期：给出提示；流失缺原因：给出提示', async () => {
    const { inf, account } = influencer('小美', 'xm001');
    const coop = cooperation(inf, account, { stage: '待建联' });
    const { call } = setup('她说下周三给答复', { confirmed: [inf.id, coop.id] });
    await expect(
      call('propose_stage_change', { cooperationId: coop.id, stage: '洽谈中' }),
    ).rejects.toThrow(/下次跟进日期/);
    const r = await call('propose_stage_change', {
      cooperationId: coop.id,
      stage: '洽谈中',
      nextFollowDateText: '下周三',
      followStatus: '待回复',
    });
    expect(r.note).toContain('10月21日 周三');
    await expect(
      call('propose_stage_change', { cooperationId: coop.id, stage: '流失' }),
    ).rejects.toThrow(/原因/);
  });

  it('合并：两个达人必须都经过确认', async () => {
    const a = influencer('小美', 'xm001');
    const b = influencer('小美美', 'xm002');
    const { call } = setup('x', { confirmed: [a.inf.id] });
    await expect(
      call('propose_merge_influencers', { keepId: a.inf.id, mergeId: b.inf.id }),
    ).rejects.toThrow(/不是本轮查询到的记录/);
  });

  it('批量修改：整批待审核，同一批次号；超过 200 条拒绝', async () => {
    const list = Array.from({ length: 3 }, (_, i) => influencer(`达人${i}`, `bulk${i}`).inf);
    const { call, cards } = setup('把这些都标成 A 级');
    await call('find_influencers', { query: '达人' });
    const r = await call('propose_bulk_update', {
      entity: 'influencer',
      ids: list.map((x) => x.id),
      patch: { rating: 'A' },
    });
    expect(r.count).toBe(3);
    expect(cards.at(-1)).toMatchObject({ kind: 'batch', count: 3 });
    const rows = sqlite.prepare('select batch_id, reason from pending_changes').all() as {
      batch_id: string;
      reason: string;
    }[];
    expect(new Set(rows.map((x) => x.batch_id)).size).toBe(1);
    expect(
      d
        .entity('influencer')
        .list()
        .every((x) => x.rating == null),
    ).toBe(true);
    await expect(
      call('propose_bulk_update', {
        entity: 'influencer',
        ids: Array.from({ length: 201 }, (_, i) => `id${i}`),
        patch: { rating: 'A' },
      }),
    ).rejects.toThrow(/200/);
    await expect(
      call('propose_bulk_update', {
        entity: 'influencer',
        ids: ['编造的id'],
        patch: { rating: 'A' },
      }),
    ).rejects.toThrow(/不存在/);
  });
});

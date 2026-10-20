import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { openDb, runMigrations } from '../db/index.ts';
import { createDomain, type Domain } from './index.ts';
import { appliedOf, type Actor, type WriteResult } from './types.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-home-'));
const { db, sqlite } = openDb(dir);
runMigrations(db);
let d: Domain;
let user: Actor;
let seq = 0;
const TODAY = '2026-10-18';

afterAll(() => {
  sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const t of [
    'change_log',
    'pending_changes',
    'follow_ups',
    'cooperation_products',
    'cooperations',
    'sample_return_items',
    'sample_returns',
    'sample_writeoffs',
    'sample_shipment_items',
    'sample_shipments',
    'influencer_addresses',
    'platform_accounts',
    'influencers',
    'contacts',
    'products',
    'app_settings',
  ])
    sqlite.exec(`delete from ${t}`);
  d = createDomain(db);
  user = d.userActor();
});

const row = (r: WriteResult) => appliedOf(r).row;
function coop(extra: Record<string, unknown> = {}, nickname = `达人${++seq}`) {
  const inf = row(d.entity('influencer').create(user, { nickname }));
  const acc = row(
    d.entity('platform_account').create(user, {
      influencerId: inf.id,
      platform: '小红书',
      accountId: `h${seq}${Math.random()}`,
    }),
  );
  const c = row(
    d
      .entity('cooperation')
      .create(user, { influencerId: inf.id, platformAccountId: acc.id, ...extra }),
  );
  return { inf, acc, c };
}

describe('首页：今日待跟进', () => {
  it('合作按逾期天数从多到少；未到期、已完成/流失/暂缓、非跟进阶段的不出现', () => {
    const a = coop({ stage: '洽谈中', nextFollowDate: '2026-10-16' }, '逾期两天');
    coop({ stage: '待建联', nextFollowDate: TODAY }, '今天');
    coop({ stage: '已确认', nextFollowDate: '2026-10-01' }, '已确认的旧日期');
    coop({ stage: '洽谈中', nextFollowDate: '2026-10-25' }, '下周');
    coop({ stage: '完成', nextFollowDate: '2026-10-01' }, '已完成');
    coop({ stage: '暂缓', nextFollowDate: '2026-10-01' }, '暂缓');
    const r = d.home.dashboard(TODAY);
    expect(r.dueFollows.map((x) => [x.name, x.overdueDays])).toEqual([
      ['逾期两天', 2],
      ['今天', 0],
    ]);
    expect(r.cards.dueFollow).toEqual({ count: 2, overdue: 1 });
    expect(r.dueFollows[0]).toMatchObject({ kind: 'cooperation', id: a.c.id, stage: '洽谈中' });
  });

  it('带出最近一次跟进里写的"下一步"', () => {
    const a = coop({ stage: '洽谈中', nextFollowDate: '2026-10-16' });
    d.entity('follow_up').create(user, {
      occurredAt: '2026-10-10T10:00:00.000Z',
      method: '微信',
      summary: '旧',
      cooperationId: a.c.id,
      nextAction: '旧的下一步',
      nextFollowDate: '2026-10-16',
    });
    d.entity('follow_up').create(user, {
      occurredAt: '2026-10-12T10:00:00.000Z',
      method: '微信',
      summary: '新',
      cooperationId: a.c.id,
      nextAction: '确认档期与佣金',
      nextFollowDate: '2026-10-16',
    });
    expect(d.home.dashboard(TODAY).dueFollows[0]!.nextAction).toBe('确认档期与佣金');
  });

  it('联系人也在其中：挂在联系人上的跟进把下次跟进日期同步给联系人', () => {
    const ct = row(
      d.entity('contact').create(user, { name: '经纪人王', type: '经纪人', org: '某MCN' }),
    );
    d.entity('follow_up').create(user, {
      occurredAt: '2026-10-10T10:00:00.000Z',
      method: '电话',
      summary: '约了回电',
      contactId: ct.id,
      nextFollowDate: '2026-10-15',
    });
    expect(d.entity('contact').require(ct.id).nextFollowDate).toBe('2026-10-15');
    const r = d.home.dashboard(TODAY);
    expect(r.dueFollows[0]).toMatchObject({
      kind: 'contact',
      name: '经纪人王',
      overdueDays: 3,
      sub: '经纪人 · 某MCN',
    });
  });
});

describe('首页：近 7 天开播', () => {
  it('列出今天起 7 天内开播的合作，标出佣金未确认和未设挂链', () => {
    const p = row(d.entity('product').create(user, { styleNo: 'A1', name: '大衣' }));
    const ok = coop({ stage: '已排期', liveDate: '2026-10-21', linkMethod: '小黄车' }, '都齐了');
    d.entity('cooperation_product').create(user, {
      cooperationId: ok.c.id as string,
      productId: p.id as string,
      commissionPct: 20,
    });
    const bad = coop({ stage: '已排期', liveDate: '2026-10-19' }, '佣金没定');
    d.entity('cooperation_product').create(user, {
      cooperationId: bad.c.id as string,
      productId: p.id as string,
    });
    coop({ stage: '已排期', liveDate: '2026-10-26' }, '第 8 天');
    coop({ stage: '已排期', liveDate: '2026-10-17' }, '昨天');
    coop({ stage: '流失', lostReason: 'x', liveDate: '2026-10-20' }, '流失的');
    const lives = d.home.dashboard(TODAY).upcomingLives;
    expect(lives.map((l) => l.influencerNickname)).toEqual(['佣金没定', '都齐了']);
    expect(lives[0]).toMatchObject({ commissionUnconfirmed: true, linkMissing: true });
    expect(lives[1]).toMatchObject({ commissionUnconfirmed: false, linkMissing: false });
    expect(d.home.dashboard(TODAY).cards.live7).toEqual({ count: 2, unconfirmed: 1 });
  });
});

describe('首页：寄样预警（按达人汇总）', () => {
  const ship = (
    infId: string,
    shippedAt: string,
    extra: { coopId?: string; sign?: string } = {},
  ) => {
    const s = d.samples.createShipment(user, {
      influencerId: infId,
      cooperationId: extra.coopId ?? null,
      items: [{ styleNo: 'A1', productName: '大衣', color: '黑', size: 'M', qty: 2 }],
    });
    row(
      d
        .entity('influencer_address')
        .create(user, { influencerId: infId, recipient: '王', address: '某地址', isDefault: true }),
    );
    const shipped = d.samples.ship(user, s.id as string, { shippedAt });
    return extra.sign ? d.samples.sign(user, s.id as string, extra.sign) : shipped;
  };

  it('逾期未寄回：显示在外件数、最早应寄回日期和逾期件数', () => {
    const { inf, c } = coop({ stage: '已排期', liveDate: '2026-10-05' }, '逾期的');
    ship(inf.id as string, '2026-10-01', { coopId: c.id as string }); // 应寄回 = 10-05 + 3
    const alert = d.home.dashboard(TODAY).sampleAlerts[0]!;
    expect(alert.nickname).toBe('逾期的');
    expect(alert.alerts[0]).toMatchObject({ type: 'overdue', badge: '逾期 2 件', tone: 'red' });
    expect(alert.alerts[0]!.text).toContain('2026-10-08');
    expect(d.home.dashboard(TODAY).cards.samples).toEqual({ outstanding: 2, overdueQty: 2 });
  });

  it('签收超过 14 天仍未开播：提示"尚未排期"；排期后改为"尚未开播"；已开播则不提示', () => {
    const { inf, c } = coop({ stage: '已确认' }, '没排期');
    ship(inf.id as string, '2026-09-25', { coopId: c.id as string, sign: '2026-09-28' });
    let a = d.home.dashboard(TODAY).sampleAlerts.find((x) => x.nickname === '没排期')!;
    expect(a.alerts.find((x) => x.type === 'notLive')).toMatchObject({
      text: '签收 20 天，尚未排期',
      badge: '未开播',
    });
    d.entity('cooperation').update(user, c.id as string, { liveDate: '2026-10-30' });
    a = d.home.dashboard(TODAY).sampleAlerts.find((x) => x.nickname === '没排期')!;
    expect(a.alerts.find((x) => x.type === 'notLive')!.text).toContain('尚未开播');
    d.entity('cooperation').update(user, c.id as string, { stage: '已开播' });
    const after = d.home.dashboard(TODAY).sampleAlerts.find((x) => x.nickname === '没排期');
    expect(after?.alerts.some((x) => x.type === 'notLive') ?? false).toBe(false);
  });

  it('阈值可在设置里改：改成 30 天后 20 天的不再提示', () => {
    const { inf, c } = coop({ stage: '已确认' }, '阈值');
    ship(inf.id as string, '2026-09-25', { coopId: c.id as string, sign: '2026-09-28' });
    d.settings.set(user, 'signedNotLiveDays', 30);
    const a = d.home.dashboard(TODAY).sampleAlerts.find((x) => x.nickname === '阈值')!;
    expect(a.alerts.map((x) => x.type)).toEqual(['overdue']); // 签收日 + 7 天已逾期，但不再提示"未开播"
  });

  it('质检问题待处理、待寄样超过 3 天未寄出', () => {
    const { inf } = coop({}, '质检');
    ship(inf.id as string, '2026-10-10');
    d.samples.createReturn(user, {
      influencerId: inf.id as string,
      returnedAt: '2026-10-15',
      items: [{ styleNo: 'A1', color: '黑', size: 'M', qty: 1, qaResult: '破损' }],
    });
    const other = row(d.entity('influencer').create(user, { nickname: '待寄样' }));
    d.samples.createShipment(user, {
      influencerId: other.id as string,
      items: [{ styleNo: 'A1', productName: '大衣', color: '黑', size: 'M', qty: 1 }],
    });
    const r = d.home.dashboard('2099-01-01');
    expect(r.sampleAlerts.find((x) => x.nickname === '质检')!.alerts.map((x) => x.type)).toContain(
      'qa',
    );
    expect(r.sampleAlerts.find((x) => x.nickname === '待寄样')!.alerts[0]).toMatchObject({
      type: 'pendingShip',
      badge: '待寄样超期',
    });
  });

  it('逾期的排在最前面', () => {
    const a = coop({ stage: '已排期', liveDate: '2026-10-05' }, '逾期');
    ship(a.inf.id as string, '2026-10-01', { coopId: a.c.id as string });
    const b = coop({}, '只有质检');
    ship(b.inf.id as string, '2026-10-10');
    d.samples.createReturn(user, {
      influencerId: b.inf.id as string,
      returnedAt: '2026-10-15',
      items: [{ styleNo: 'A1', color: '黑', size: 'M', qty: 1, qaResult: '污渍' }],
    });
    expect(d.home.dashboard(TODAY).sampleAlerts.map((x) => x.nickname)).toEqual([
      '逾期',
      '只有质检',
    ]);
  });
});

describe('首页：数字与规则摘要', () => {
  it('待审核数量计入，摘要按规则生成', () => {
    const a = coop({ stage: '洽谈中', nextFollowDate: '2026-10-16' }, '小美');
    d.entity('influencer').delete(
      { type: 'agent', userId: d.userId, source: '测试' },
      a.inf.id as string,
    );
    const r = d.home.dashboard(TODAY);
    expect(r.cards.pendingReview).toBe(1);
    expect(r.highlights.join('')).toContain('等待审核');
    expect(r.highlights.join('')).toContain('跟进已逾期');
  });
});

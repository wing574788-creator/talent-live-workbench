import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { openDb, runMigrations } from '../db/index.ts';
import { changeLog } from '../db/schema.ts';
import { createDomain, type Domain } from './index.ts';
import { appliedOf, type Actor, type Row, type WriteResult } from './types.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-coop-'));
const { db, sqlite } = openDb(dir);
runMigrations(db);
let d: Domain;
let user: Actor;
let seq = 0;
const agent: () => Actor = () => ({ type: 'agent', userId: d.userId, source: '测试原文' });
const row = (r: WriteResult) => appliedOf(r).row;

afterAll(() => {
  sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const t of [
    'change_log',
    'pending_changes',
    'cooperation_products',
    'cooperations',
    'follow_ups',
    'sample_shipment_items',
    'sample_shipments',
    'sample_return_items',
    'sample_returns',
    'sample_writeoffs',
    'influencers',
    'platform_accounts',
    'products',
    'enum_options',
    'app_settings',
  ])
    sqlite.exec(`delete from ${t}`);
  d = createDomain(db);
  user = d.userActor();
});

function setup(extra: Record<string, unknown> = {}) {
  const inf = row(d.entity('influencer').create(user, { nickname: '小美' }));
  const acc = row(
    d
      .entity('platform_account')
      .create(user, { influencerId: inf.id, platform: '小红书', accountId: 'xm' + ++seq }),
  );
  const coop = row(
    d
      .entity('cooperation')
      .create(user, { influencerId: inf.id, platformAccountId: acc.id, ...extra }),
  );
  return { inf, acc, coop };
}
const upd = (id: string, patch: Record<string, unknown>) =>
  d.entity('cooperation').update(user, id, patch);
const coopOf = (id: string) => d.entity('cooperation').require(id);
const followUp = (coopId: string, extra: Record<string, unknown> = {}) =>
  d.entity('follow_up').create(user, {
    occurredAt: new Date().toISOString(),
    method: '微信',
    summary: '聊了',
    cooperationId: coopId,
    ...extra,
  });

describe('阶段规则', () => {
  it('进入流失或放弃必须填写原因', () => {
    const { coop } = setup();
    expect(() => upd(coop.id, { stage: '流失' })).toThrow(/原因/);
    expect(() => upd(coop.id, { stage: '放弃', lostReason: ' ' })).toThrow(/原因/);
    expect(upd(coop.id, { stage: '流失', lostReason: '对方无档期' }).status).toBe('applied');
  });

  it('洽谈中的合作必须有下次跟进日期', () => {
    expect(() => setup({ stage: '洽谈中' })).toThrow(/下次跟进日期/);
    const { coop } = setup();
    expect(() => upd(coop.id, { stage: '洽谈中' })).toThrow(/下次跟进日期/);
    expect(upd(coop.id, { stage: '洽谈中', nextFollowDate: '2099-10-21' }).status).toBe('applied');
  });

  it('平台账号必须属于所选达人', () => {
    const { inf } = setup();
    const other = row(d.entity('influencer').create(user, { nickname: '阿花' }));
    const otherAcc = row(
      d
        .entity('platform_account')
        .create(user, { influencerId: other.id, platform: '抖音', accountId: 'dy1' }),
    );
    expect(() =>
      d
        .entity('cooperation')
        .create(user, { influencerId: inf.id, platformAccountId: otherAcc.id }),
    ).toThrow(/不属于/);
  });

  it('阶段变化写入变更日志，且可撤销', () => {
    const { coop } = setup();
    const res = appliedOf(upd(coop.id, { stage: '已确认' }));
    const log = db.select().from(changeLog).where(eq(changeLog.id, res.logId)).get()!;
    expect((log.before as Row).stage).toBe('待建联');
    expect((log.after as Row).stage).toBe('已确认');
    d.review.undo(user, res.logId);
    expect(coopOf(coop.id).stage).toBe('待建联');
  });

  it('跟进状态必须在可选项里；设置里增加后即可使用，删除后不影响已有记录', () => {
    const { coop } = setup({ stage: '洽谈中', nextFollowDate: '2099-10-21' });
    expect(d.settings.followStatuses()).toEqual([
      '已发邀约',
      '待回复',
      '报价中',
      '选款中',
      '等档期',
      '暂无意向',
    ]);
    expect(() => upd(coop.id, { followStatus: '谈崩了' })).toThrow(/不在可选项/);
    d.entity('enum_option').create(user, { group: 'follow_status', value: '谈崩了', sortOrder: 9 });
    expect(upd(coop.id, { followStatus: '谈崩了' }).status).toBe('applied');
    const opt = d.entity('enum_option').findBy('value', '谈崩了')[0]!;
    d.entity('enum_option').delete(user, opt.id);
    expect(coopOf(coop.id).followStatus).toBe('谈崩了');
    expect(d.settings.followStatuses()).not.toContain('谈崩了');
  });
});

describe('合作商品：每个商品佣金可以不同', () => {
  it('同一场合作不同商品各设佣金；AI 改佣金只进待审核', () => {
    const { coop } = setup();
    const p1 = row(d.entity('product').create(user, { styleNo: 'A1', name: '大衣' }));
    const p2 = row(d.entity('product').create(user, { styleNo: 'A2', name: '风衣' }));
    const cp1 = row(
      d.entity('cooperation_product').create(user, {
        cooperationId: coop.id,
        productId: p1.id,
        commissionPct: 20,
        livePriceCents: 129900,
      }),
    );
    row(
      d
        .entity('cooperation_product')
        .create(user, { cooperationId: coop.id, productId: p2.id, commissionPct: 25 }),
    );
    const detail = d.cooperations.detail(coop.id);
    expect(detail.products.map((p) => (p as Row).commissionPct).sort()).toEqual([20, 25]);
    expect(
      d.entity('cooperation_product').update(agent(), cp1.id, { commissionPct: 30 }).status,
    ).toBe('pending');
    const list = d.cooperations.listEnriched({});
    expect(list.rows[0]).toMatchObject({ productCount: 2, commissionMin: 20, commissionMax: 25 });
  });
});

describe('跟进记录', () => {
  it('至少关联合作、达人或联系人之一', () => {
    expect(() =>
      d
        .entity('follow_up')
        .create(user, { occurredAt: new Date().toISOString(), method: '微信', summary: 'x' }),
    ).toThrow(/至少/);
  });

  it('保存后同步跟进状态和下次跟进日期到合作；时间线也挂到达人', () => {
    const { coop, inf } = setup({ stage: '洽谈中', nextFollowDate: '2099-10-20' });
    followUp(coop.id, { followStatus: '报价中', nextFollowDate: '2099-10-25' });
    expect(coopOf(coop.id)).toMatchObject({ followStatus: '报价中', nextFollowDate: '2099-10-25' });
    expect(d.read.influencerDetail(inf.id).followUps).toHaveLength(1);
  });

  it('洽谈中的合作保存跟进时没有任何下次跟进日期会被拒绝（提示补上）', () => {
    const { coop } = setup({ stage: '洽谈中', nextFollowDate: '2099-10-20' });
    sqlite.exec(`update cooperations set next_follow_date = null where id = '${coop.id}'`); // 模拟历史遗留数据
    expect(() => followUp(coop.id)).toThrow(/下次跟进日期/);
    expect(followUp(coop.id, { nextFollowDate: '2099-10-22' }).status).toBe('applied');
    expect(coopOf(coop.id).nextFollowDate).toBe('2099-10-22');
  });

  it('跟进次数、距上次跟进天数；连续 3 次"待回复"提醒，阈值可配置', () => {
    const { coop } = setup({ stage: '洽谈中', nextFollowDate: '2099-10-20' });
    const at = (i: number) => new Date(Date.now() - (10 - i) * 1000).toISOString();
    followUp(coop.id, { followStatus: '已发邀约', occurredAt: at(1) });
    followUp(coop.id, { followStatus: '待回复', occurredAt: at(2) });
    followUp(coop.id, { followStatus: '待回复', occurredAt: at(3) });
    let stats = d.cooperations.detail(coop.id).stats;
    expect(stats).toMatchObject({ followCount: 3, stalled: false, daysSinceFollow: 0 });
    followUp(coop.id, { followStatus: '待回复', occurredAt: at(4) });
    expect(d.cooperations.detail(coop.id).stats.stalled).toBe(true);
    expect(d.cooperations.listEnriched({}).rows[0]!.stalled).toBe(true);
    d.settings.set(user, 'replyStallCount', 5);
    stats = d.cooperations.detail(coop.id).stats;
    expect(stats).toMatchObject({ stalled: false, stallCount: 5 });
  });
});

describe('阶段自动推进（PRD 5.3 验收）', () => {
  const shipment = (infId: string, coopId: string, extra: Record<string, unknown> = {}) =>
    row(
      d
        .entity('sample_shipment')
        .create(user, { influencerId: infId, cooperationId: coopId, ...extra }),
    );
  const item = (shipmentId: string, qty = 1, size = 'M') =>
    row(
      d.entity('sample_shipment_item').create(user, {
        shipmentId,
        styleNo: 'A001',
        productName: '羊毛大衣',
        color: '黑色',
        size,
        qty,
      }),
    );

  it('新建待寄样单 → 待寄样；寄出 → 已排期；开播日过后 → 已开播；仍有在外 → 待退样；结清 → 待复盘', () => {
    const { coop, inf } = setup({ stage: '已确认', liveDate: '2026-10-10' });
    const s = shipment(inf.id, coop.id);
    expect(coopOf(coop.id).stage).toBe('待寄样');

    item(s.id, 2);
    d.entity('sample_shipment').update(user, s.id, { status: '已寄出', shippedAt: '2026-10-05' });
    expect(coopOf(coop.id).stage).toBe('已排期');

    d.automation.runDaily('2026-10-09');
    expect(coopOf(coop.id).stage).toBe('已排期'); // 开播日当天及之前不动
    d.automation.runDaily('2026-10-11');
    expect(coopOf(coop.id).stage).toBe('待退样'); // 已开播且仍有 2 件在外，同一轮继续推进

    const ret = row(
      d.entity('sample_return').create(user, { influencerId: inf.id, returnedAt: '2026-10-15' }),
    );
    row(
      d.entity('sample_return_item').create(user, {
        returnId: ret.id,
        styleNo: 'A001',
        productName: '羊毛大衣',
        color: '黑色',
        size: 'M',
        qty: 1,
        qaResult: '完好',
      }),
    );
    expect(coopOf(coop.id).stage).toBe('待退样'); // 还差 1 件
    row(
      d.entity('sample_return_item').create(user, {
        returnId: ret.id,
        styleNo: 'A001',
        productName: '羊毛大衣',
        color: '黑色',
        size: 'M',
        qty: 1,
        qaResult: '完好',
      }),
    );
    expect(coopOf(coop.id).stage).toBe('待复盘');
  });

  it('只有"已寄出"之后才计入在外；待寄样单不会触发待退样', () => {
    const { coop, inf } = setup({ stage: '已开播' });
    const s = shipment(inf.id, coop.id);
    item(s.id, 3);
    d.automation.runDaily('2026-12-01');
    expect(coopOf(coop.id).stage).toBe('已开播');
  });

  it('自动推进写日志（来源标"自动推进"），可手动改回，且不会被反复推走', () => {
    const { coop } = setup({ stage: '已排期', liveDate: '2026-10-10' });
    d.automation.runDaily('2026-10-11');
    expect(coopOf(coop.id).stage).toBe('已开播');
    const log = db
      .select()
      .from(changeLog)
      .where(eq(changeLog.entityId, coop.id))
      .all()
      .find((l) => (l.after as Row)?.stage === '已开播')!;
    expect(log.source).toMatch(/^自动推进/);
    upd(coop.id, { stage: '已排期' }); // 手动改回
    d.automation.runDaily('2026-10-12');
    expect(coopOf(coop.id).stage).toBe('已排期');
  });

  it('核销样品也会让在外归零并推进到待复盘；交叉合作（一个达人两场）按达人汇总', () => {
    const { coop, inf, acc } = setup({ stage: '已排期', liveDate: '2026-10-01' });
    const coop2 = row(
      d
        .entity('cooperation')
        .create(user, { influencerId: inf.id, platformAccountId: acc.id, stage: '待建联' }),
    );
    const s = shipment(inf.id, coop.id, { status: '已寄出' });
    item(s.id, 2);
    d.automation.runDaily('2026-10-05');
    expect(coopOf(coop.id).stage).toBe('待退样');
    expect(coopOf(coop2.id).stage).toBe('待建联'); // 另一场合作不受影响
    row(
      d.entity('sample_writeoff').create(user, {
        influencerId: inf.id,
        styleNo: 'A001',
        productName: '羊毛大衣',
        color: '黑色',
        size: 'M',
        qty: 2,
        reason: '达人买断',
        occurredAt: '2026-10-06',
      }),
    );
    expect(coopOf(coop.id).stage).toBe('待复盘');
  });
});

describe('合作跟踪简化：跟进字段与样品口径', () => {
  const shipItem = (infId: string, coopId: string | null, qty = 1) => {
    const s = row(
      d.entity('sample_shipment').create(user, { influencerId: infId, cooperationId: coopId }),
    );
    row(
      d.entity('sample_shipment_item').create(user, {
        shipmentId: s.id,
        styleNo: 'A001',
        productName: '羊毛大衣',
        color: '黑色',
        size: 'M',
        qty,
      }),
    );
    d.entity('sample_shipment').update(user, s.id, { status: '已寄出', shippedAt: '2026-10-05' });
    return s;
  };

  it('在外样品按关联合作计算：同一达人另一场合作的在外样品不会把这场推到待退样', () => {
    const { coop: a, inf, acc } = setup({ stage: '已确认', liveDate: '2026-10-10' });
    const b = row(
      d.entity('cooperation').create(user, {
        influencerId: inf.id,
        platformAccountId: acc.id,
        stage: '已排期',
        liveDate: '2026-10-08',
      }),
    );
    shipItem(inf.id, a.id, 2); // A 的样品在外
    shipItem(inf.id, null, 1); // 没关联合作的寄样单不参与推进
    d.automation.runDaily('2026-10-11');
    expect(coopOf(a.id).stage).toBe('待退样');
    expect(coopOf(b.id).stage).toBe('已开播'); // 以前会被 A 的样品推到待退样
  });

  it('离开洽谈中清空下次跟进日期和跟进状态，首页不再算待跟进；改回洽谈中要重新填', () => {
    const { coop } = setup({
      stage: '洽谈中',
      nextFollowDate: '2026-10-01',
      followStatus: '报价中',
    });
    expect(d.home.dueFollows('2026-10-20').some((r) => r.id === coop.id)).toBe(true);
    upd(coop.id, { stage: '已确认' });
    expect(coopOf(coop.id)).toMatchObject({ nextFollowDate: null, followStatus: null });
    expect(d.home.dueFollows('2026-10-20').some((r) => r.id === coop.id)).toBe(false);
    expect(() => upd(coop.id, { stage: '洽谈中' })).toThrow(/下次跟进日期/);
  });

  it('离开流失后旧原因被清掉，再次进入流失必须重新填写', () => {
    const { coop } = setup();
    upd(coop.id, { stage: '流失', lostReason: '没档期' });
    upd(coop.id, { stage: '洽谈中', nextFollowDate: '2099-01-01' });
    expect(coopOf(coop.id).lostReason).toBeNull();
    expect(() => upd(coop.id, { stage: '流失' })).toThrow(/原因/);
  });

  it('洽谈中记跟进：合作上已过期的日期不算数；非跟进阶段的合作不回写跟进状态和日期', () => {
    const { coop } = setup({ stage: '洽谈中', nextFollowDate: '2020-01-01' });
    expect(() => followUp(coop.id)).toThrow(/今天或之后/);
    expect(followUp(coop.id, { nextFollowDate: '2099-01-02' }).status).toBe('applied');

    const { coop: done } = setup({ stage: '已排期' });
    followUp(done.id, { followStatus: '报价中', nextFollowDate: '2099-01-03' });
    expect(coopOf(done.id)).toMatchObject({ followStatus: null, nextFollowDate: null });
  });
});

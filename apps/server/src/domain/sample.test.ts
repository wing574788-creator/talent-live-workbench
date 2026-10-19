import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { openDb, runMigrations } from '../db/index.ts';
import { changeLog } from '../db/schema.ts';
import { createDomain, type Domain } from './index.ts';
import { keyTotals, replayLedger } from './sample-ledger.ts';
import { appliedOf, type Actor, type Row } from './types.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-sample-'));
const { db, sqlite } = openDb(dir);
runMigrations(db);
let d: Domain;
let user: Actor;
let seq = 0;

afterAll(() => {
  sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const t of [
    'change_log',
    'pending_changes',
    'sample_return_items',
    'sample_returns',
    'sample_writeoffs',
    'sample_shipment_items',
    'sample_shipments',
    'cooperations',
    'influencer_addresses',
    'platform_accounts',
    'influencers',
    'products',
    'app_settings',
    'attachments',
  ])
    sqlite.exec(`delete from ${t}`);
  d = createDomain(db);
  user = d.userActor();
});

const row = (r: { status: string }) => appliedOf(r as never).row;

/** 达人 + 账号 + 默认地址，可选合作（带开播日） */
function fixture(opts: { liveDate?: string; coopStage?: string } = {}) {
  const inf = row(
    d.entity('influencer').create(user, { nickname: `小美${++seq}`, recycleIssueCount: 0 }),
  );
  const acc = row(
    d
      .entity('platform_account')
      .create(user, { influencerId: inf.id, platform: '小红书', accountId: `acc${seq}` }),
  );
  row(
    d.entity('influencer_address').create(user, {
      influencerId: inf.id,
      recipient: '王一',
      phone: '13812345678',
      address: '上海市徐汇区某路 1 号',
      isDefault: true,
    }),
  );
  const coop =
    opts.liveDate || opts.coopStage
      ? row(
          d.entity('cooperation').create(user, {
            influencerId: inf.id,
            platformAccountId: acc.id,
            stage: opts.coopStage ?? '已排期',
            liveDate: opts.liveDate ?? null,
          }),
        )
      : null;
  return { inf, acc, coop };
}
const prod = (styleNo = 'A001', name = '羊毛大衣') =>
  row(d.entity('product').create(user, { styleNo, name }));
const S = () => d.samples;
const reg = () => ({ get: (n: string) => d.entity(n) });

/** 创建并寄出一张寄样单 */
function ship(
  infId: string,
  items: { styleNo?: string; color?: string; size?: string; qty: number }[],
  shippedAt: string,
  extra: { coopId?: string | null } = {},
) {
  const s = S().createShipment(user, {
    influencerId: infId,
    cooperationId: extra.coopId ?? null,
    items: items.map((i) => ({
      styleNo: i.styleNo ?? 'A001',
      productName: '羊毛大衣',
      color: i.color ?? '黑色',
      size: i.size ?? 'M',
      qty: i.qty,
    })),
  });
  return S().ship(user, s.id as string, { shippedAt });
}
const ret = (
  infId: string,
  returnedAt: string,
  items: {
    color?: string;
    size?: string;
    qty: number;
    qaResult?: string | null;
    disposition?: string;
  }[],
) =>
  S().createReturn(user, {
    influencerId: infId,
    returnedAt,
    items: items.map((i) => ({
      styleNo: 'A001',
      color: i.color ?? '黑色',
      size: i.size ?? 'M',
      qty: i.qty,
      qaResult: i.qaResult ?? null,
      disposition: i.disposition ?? null,
    })),
  });

describe('在外结余与逐款色码计算', () => {
  it('在外 = 累计寄出 − 退回 − 核销，只计已寄出之后的寄样单', () => {
    const { inf } = fixture();
    prod();
    ship(inf.id, [{ qty: 2 }], '2026-10-01');
    S().createShipment(user, {
      influencerId: inf.id,
      items: [{ styleNo: 'A001', productName: '羊毛大衣', color: '黑色', size: 'M', qty: 5 }],
    }); // 待寄样，不计入
    const t = keyTotals(reg(), inf.id)[0]!;
    expect(t).toMatchObject({ shipped: 2, returned: 0, outstanding: 2 });
    ret(inf.id, '2026-10-05', [{ qty: 1, qaResult: '完好' }]);
    S().createWriteoff(user, {
      influencerId: inf.id,
      styleNo: 'A001',
      color: '黑色',
      size: 'M',
      qty: 1,
      reason: '报损',
      occurredAt: '2026-10-06',
    });
    expect(keyTotals(reg(), inf.id)[0]).toMatchObject({
      shipped: 2,
      returned: 1,
      writtenOff: 1,
      outstanding: 0,
    });
  });

  it('退回按款色码从最早未结清的寄出记录开始冲抵（FIFO）', () => {
    const { inf } = fixture();
    prod();
    const early = ship(inf.id, [{ qty: 1 }], '2026-10-01');
    const late = ship(inf.id, [{ qty: 1 }], '2026-10-05');
    ret(inf.id, '2026-10-10', [{ qty: 1, qaResult: '完好' }]);
    const lines = replayLedger(reg(), inf.id).lines;
    const openBy = (sid: string) => lines.find((l) => l.shipmentId === sid)!.open;
    expect(openBy(early.id as string)).toBe(0);
    expect(openBy(late.id as string)).toBe(1);
  });

  it('同一个包裹的退回可以包含多场合作的样衣（不指定来自哪张寄样单）', () => {
    const { inf } = fixture();
    prod();
    prod('B002', '碎花连衣裙');
    const s1 = S().createShipment(user, {
      influencerId: inf.id,
      items: [{ styleNo: 'A001', productName: '羊毛大衣', color: '黑色', size: 'M', qty: 1 }],
    });
    S().ship(user, s1.id as string, { shippedAt: '2026-10-01' });
    const s2 = S().createShipment(user, {
      influencerId: inf.id,
      items: [{ styleNo: 'B002', productName: '碎花连衣裙', color: '白色', size: 'S', qty: 2 }],
    });
    S().ship(user, s2.id as string, { shippedAt: '2026-10-02' });
    S().createReturn(user, {
      influencerId: inf.id,
      returnedAt: '2026-10-09',
      items: [
        { styleNo: 'A001', color: '黑色', size: 'M', qty: 1, qaResult: '完好' },
        { styleNo: 'B002', color: '白色', size: 'S', qty: 2, qaResult: '完好' },
      ],
    });
    expect(keyTotals(reg(), inf.id).reduce((n, t) => n + t.outstanding, 0)).toBe(0);
  });

  it('退回或核销数量超过在外数量会被拒绝，且整单不落库', () => {
    const { inf } = fixture();
    prod();
    ship(inf.id, [{ qty: 1 }], '2026-10-01');
    expect(() => ret(inf.id, '2026-10-02', [{ qty: 2 }])).toThrow(/在外只有 1 件/);
    expect(() =>
      S().createWriteoff(user, {
        influencerId: inf.id,
        styleNo: 'A001',
        color: '黑色',
        size: 'M',
        qty: 3,
        reason: '赠送',
        occurredAt: '2026-10-02',
      }),
    ).toThrow(/不能核销/);
    expect(
      db.select().from(changeLog).where(eq(changeLog.entity, 'sample_return')).all(),
    ).toHaveLength(0);
  });
});

describe('寄出、签收与应寄回日期', () => {
  it('新建待寄样单后寄出：必须有收货地址；没有地址时给出提示', () => {
    const inf = row(d.entity('influencer').create(user, { nickname: '无地址' }));
    prod();
    const s = S().createShipment(user, {
      influencerId: inf.id,
      items: [{ styleNo: 'A001', productName: '羊毛大衣', color: '黑色', size: 'M', qty: 1 }],
    });
    expect(() => S().ship(user, s.id as string, { shippedAt: '2026-10-01' })).toThrow(/收货地址/);
    expect(d.entity('sample_shipment').require(s.id as string).status).toBe('待寄样');
  });

  it('有开播日：应寄回 = 开播日 + N（默认 3）；未排期：签收日 + M（默认 7）', () => {
    const withLive = fixture({ liveDate: '2026-10-20' });
    prod();
    const a = ship(withLive.inf.id, [{ qty: 1 }], '2026-10-10', { coopId: withLive.coop!.id });
    expect(a.dueBackDate).toBe('2026-10-23');

    const noLive = fixture();
    const b = ship(noLive.inf.id, [{ qty: 1 }], '2026-10-10');
    expect(b.dueBackDate).toBeNull(); // 未签收、未排期，暂不计算
    const signed = S().sign(user, b.id as string, '2026-10-12');
    expect(signed).toMatchObject({ status: '已签收', dueBackDate: '2026-10-19' });
  });

  it('延期必须填写说明，说明记入变更日志；只有已寄出的样衣可以延期', () => {
    const { inf } = fixture({ liveDate: '2026-10-20' });
    prod();
    const s = ship(inf.id, [{ qty: 1 }], '2026-10-10');
    expect(() => S().extendDue(user, s.id as string, '2026-11-01', '  ')).toThrow(/说明/);
    S().extendDue(user, s.id as string, '2026-11-01', '留给下一场直播用');
    expect(d.entity('sample_shipment').require(s.id as string).dueBackDate).toBe('2026-11-01');
    const log = db
      .select()
      .from(changeLog)
      .where(eq(changeLog.entityId, s.id as string))
      .all()
      .at(-1)!;
    expect(log.source).toBe('延期：留给下一场直播用');
    const draft = S().createShipment(user, {
      influencerId: inf.id,
      items: [{ styleNo: 'A001', productName: 'x', color: '黑色', size: 'M', qty: 1 }],
    });
    expect(() => S().extendDue(user, draft.id as string, '2026-11-01', 'x')).toThrow(/已寄出/);
  });

  it('批量标记寄出：逐条独立，失败的单条不影响其他', () => {
    const { inf } = fixture();
    prod();
    const ok = S().createShipment(user, {
      influencerId: inf.id,
      items: [{ styleNo: 'A001', productName: 'x', color: '黑色', size: 'M', qty: 1 }],
    });
    const noSigned = S().createShipment(user, {
      influencerId: row(d.entity('influencer').create(user, { nickname: '无地址者' })).id,
      items: [{ styleNo: 'A001', productName: 'x', color: '黑色', size: 'M', qty: 1 }],
    });
    const res = S().shipMany(user, [ok.id as string, noSigned.id as string], '2026-10-01');
    expect(res.shipped).toEqual([ok.id]);
    expect(res.failed).toHaveLength(1);
  });
});

describe('质检与回收问题次数（PRD 5.5）', () => {
  it('每出现一次质检问题，达人的回收问题次数加 1；撤销后减回', () => {
    const { inf } = fixture();
    prod();
    ship(inf.id, [{ qty: 3 }], '2026-10-01');
    const r = ret(inf.id, '2026-10-05', [
      { qty: 1, qaResult: '完好' },
      { qty: 1, qaResult: '污渍' },
    ]);
    expect(d.entity('influencer').require(inf.id).recycleIssueCount).toBe(1);
    const item = d
      .entity('sample_return_item')
      .findBy('returnId', r.id as string)
      .find((i) => i.qaResult === '污渍')!;
    d.entity('sample_return_item').update(user, item.id as string, { qaResult: '破损' }); // 已经是问题，不重复计
    expect(d.entity('influencer').require(inf.id).recycleIssueCount).toBe(1);
    d.entity('sample_return_item').update(user, item.id as string, { qaResult: '完好' });
    expect(d.entity('influencer').require(inf.id).recycleIssueCount).toBe(0);
  });

  it('质检结果后补填也计数；撤销退回明细的创建同样回退计数', () => {
    const { inf } = fixture();
    prod();
    ship(inf.id, [{ qty: 2 }], '2026-10-01');
    const r = ret(inf.id, '2026-10-05', [{ qty: 1, qaResult: null }]);
    expect(d.entity('influencer').require(inf.id).recycleIssueCount).toBe(0);
    const item = d.entity('sample_return_item').findBy('returnId', r.id as string)[0]!;
    const res = d
      .entity('sample_return_item')
      .update(user, item.id as string, { qaResult: '缺配件' });
    expect(d.entity('influencer').require(inf.id).recycleIssueCount).toBe(1);
    d.review.undo(user, appliedOf(res).logId);
    expect(d.entity('influencer').require(inf.id).recycleIssueCount).toBe(0);
  });

  it('有问题且未处理的退样明细计入"质检待处理"；处理后不再计入', () => {
    const { inf } = fixture();
    prod();
    ship(inf.id, [{ qty: 2 }], '2026-10-01');
    ret(inf.id, '2026-10-05', [{ qty: 1, qaResult: '破损' }]);
    expect(
      S()
        .summaries()
        .find((s) => s.influencer.id === inf.id)!.qaPending,
    ).toBe(1);
    const item = d.entity('sample_return_item').list()[0]!;
    d.entity('sample_return_item').update(user, item.id as string, { disposition: '报损' });
    expect(
      S()
        .summaries()
        .find((s) => s.influencer.id === inf.id)!.qaPending,
    ).toBe(0);
  });
});

describe('达人样品页汇总与逾期', () => {
  it('在外结余按款色码列出最早应寄回日期；过期的标为逾期', () => {
    const { inf, coop } = fixture({ liveDate: '2026-10-05' });
    prod();
    ship(inf.id, [{ qty: 2 }], '2026-10-01', { coopId: coop!.id });
    const det = S().detail(inf.id, '2026-10-10');
    expect(det.totals[0]).toMatchObject({
      outstanding: 2,
      dueBackDate: '2026-10-08',
      overdue: true,
    });
    expect(det.summary).toMatchObject({ outstanding: 2, overdueQty: 2, canClearAddress: false });
    expect(S().summaries('2026-10-10')[0]).toMatchObject({ overdueQty: 2 });
  });

  it('流水时间线按日期倒序，包含寄出、退回和核销', () => {
    const { inf } = fixture();
    prod();
    ship(inf.id, [{ qty: 2 }], '2026-10-01');
    ret(inf.id, '2026-10-12', [{ qty: 1, qaResult: '完好' }]);
    S().createWriteoff(user, {
      influencerId: inf.id,
      styleNo: 'A001',
      color: '黑色',
      size: 'M',
      qty: 1,
      reason: '达人买断',
      occurredAt: '2026-10-15',
    });
    expect(
      S()
        .detail(inf.id)
        .timeline.map((t) => t.type),
    ).toEqual(['writeoff', 'return', 'ship']);
  });

  it('结清后可清除收货地址；未结清时拒绝', () => {
    const { inf } = fixture();
    prod();
    ship(inf.id, [{ qty: 1 }], '2026-10-01');
    expect(() => S().clearAddresses(user, inf.id)).toThrow(/结清/);
    ret(inf.id, '2026-10-02', [{ qty: 1, qaResult: '完好' }]);
    expect(S().clearAddresses(user, inf.id)).toBe(1);
    expect(d.entity('influencer_address').findBy('influencerId', inf.id)).toHaveLength(0);
  });
});

describe('交叉合作：上一场的样衣留给下一场', () => {
  it('延期不产生退回，只延后应寄回日期', () => {
    const { inf, coop } = fixture({ liveDate: '2026-10-05' });
    prod();
    const s = ship(inf.id, [{ qty: 1 }], '2026-10-01', { coopId: coop!.id });
    S().extendDue(user, s.id as string, '2026-10-30', '下一场直播还用这件');
    expect(keyTotals(reg(), inf.id)[0]).toMatchObject({
      outstanding: 1,
      returned: 0,
      dueBackDate: '2026-10-30',
    });
  });
});

// 避免 Row 类型未用的警告
export type _Row = Row;

describe('应寄回天数可在设置里自定义', () => {
  it('改了 N、M 后，之后寄出/签收的寄样单按新天数计算；已有的不变', () => {
    const a = fixture({ liveDate: '2026-10-20' });
    prod();
    const before = ship(a.inf.id, [{ qty: 1 }], '2026-10-10', { coopId: a.coop!.id });
    expect(before.dueBackDate).toBe('2026-10-23'); // 默认 N = 3

    d.settings.set(user, 'returnAfterLiveDays', 10);
    d.settings.set(user, 'returnAfterSignDays', 2);
    const after = ship(a.inf.id, [{ qty: 1 }], '2026-10-11', { coopId: a.coop!.id });
    expect(after.dueBackDate).toBe('2026-10-30'); // 开播日 + 10
    expect(d.entity('sample_shipment').require(before.id as string).dueBackDate).toBe('2026-10-23');

    const b = fixture();
    const signed = S().sign(
      user,
      ship(b.inf.id, [{ qty: 1 }], '2026-10-10').id as string,
      '2026-10-12',
    );
    expect(signed.dueBackDate).toBe('2026-10-14'); // 签收日 + 2
  });

  it('N 可以是 0：开播当天就要寄回', () => {
    const a = fixture({ liveDate: '2026-10-20' });
    prod();
    d.settings.set(user, 'returnAfterLiveDays', 0);
    expect(ship(a.inf.id, [{ qty: 1 }], '2026-10-10', { coopId: a.coop!.id }).dueBackDate).toBe(
      '2026-10-20',
    );
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { openDb, runMigrations } from '../db/index.ts';
import { changeLog, pendingChanges } from '../db/schema.ts';
import { DomainError } from './errors.ts';
import { createDomain, type Domain } from './index.ts';
import { appliedOf, type Actor, type Row, type WriteResult } from './types.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-domain-'));
const { db, sqlite } = openDb(dir);
runMigrations(db);
let d: Domain;
let user: Actor;
const agent = (batchId?: string): Actor => ({
  type: 'agent',
  userId: d.userId,
  batchId,
  source: '测试原文',
});

afterAll(() => {
  sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const t of [
    'change_log',
    'pending_changes',
    'cooperations',
    'influencers',
    'platform_accounts',
    'products',
  ]) {
    sqlite.exec(`delete from ${t}`);
  }
  d = createDomain(db);
  user = d.userActor();
});

const applied = (r: WriteResult) => appliedOf(r);
function makeCoop(extra: Record<string, unknown> = {}) {
  const inf = applied(d.entity('influencer').create(user, { nickname: '小美' })).row;
  const acc = applied(
    d
      .entity('platform_account')
      .create(user, { influencerId: inf.id, platform: '小红书', accountId: 'xm001' }),
  ).row;
  const coop = applied(
    d
      .entity('cooperation')
      .create(user, { influencerId: inf.id, platformAccountId: acc.id, ...extra }),
  ).row;
  return { inf, acc, coop };
}

describe('默认用户与公共字段', () => {
  it('自动创建唯一的默认用户，新记录带公共字段', () => {
    expect(createDomain(db).userId).toBe(d.userId);
    const { row } = applied(d.entity('influencer').create(user, { nickname: '小美' }));
    expect(row.id).toMatch(/^[0-9A-Z]{26}$/);
    expect(row).toMatchObject({
      version: 1,
      createdBy: d.userId,
      ownerId: d.userId,
      deletedAt: null,
    });
  });
});

describe('校验', () => {
  it('必填字段缺失、多余字段、金额非整数都会被拒绝', () => {
    const p = d.entity('product');
    expect(() => p.create(user, { name: '大衣' })).toThrow(DomainError);
    expect(() => p.create(user, { styleNo: 'A1', name: '大衣', foo: 1 })).toThrow(DomainError);
    expect(() => p.create(user, { styleNo: 'A1', name: '大衣', livePriceCents: 99.5 })).toThrow(
      DomainError,
    );
  });

  it('补丁不会被 schema 默认值覆盖未传字段', () => {
    const { coop } = makeCoop({ stage: '洽谈中', nextFollowDate: '2026-10-21' });
    d.entity('cooperation').update(user, coop.id, { liveSlot: '20:00' });
    expect(d.entity('cooperation').require(coop.id)).toMatchObject({
      stage: '洽谈中',
      liveSlot: '20:00',
    });
  });

  it('不能通过补丁改系统字段', () => {
    const { coop } = makeCoop();
    expect(() => d.entity('cooperation').update(user, coop.id, { version: 99 })).toThrow(
      DomainError,
    );
  });
});

describe('平台账号唯一键', () => {
  it('平台 + 账号 ID 重复无法创建；软删除后可重新使用', () => {
    const { inf, acc } = makeCoop();
    const svc = d.entity('platform_account');
    const dup = { influencerId: inf.id, platform: '小红书', accountId: 'xm001' };
    expect(() => svc.create(user, dup)).toThrow(/已存在/);
    expect(() => svc.create(user, { ...dup, platform: '抖音' })).not.toThrow();
    svc.delete(user, acc.id);
    expect(() => svc.create(user, dup)).not.toThrow();
  });
});

describe('变更日志', () => {
  it('创建、修改、删除各记一条，含前后快照、操作者和版本号', () => {
    const svc = d.entity('influencer');
    const { row } = applied(svc.create(user, { nickname: '小美' }));
    applied(svc.update(user, row.id, { rating: 'A' }));
    applied(svc.delete(user, row.id));
    const logs = db
      .select()
      .from(changeLog)
      .where(eq(changeLog.entityId, row.id))
      .orderBy(changeLog.id)
      .all();
    expect(logs.map((l) => l.action)).toEqual(['create', 'update', 'delete']);
    expect(logs[0]!.before).toBeNull();
    expect((logs[1]!.before as Row).rating).toBeNull();
    expect((logs[1]!.after as Row).rating).toBe('A');
    expect((logs[1]!.after as Row).version).toBe(2);
    expect(logs.every((l) => l.actorType === 'user')).toBe(true);
  });

  it('没有实际变化的更新不写日志、不涨版本', () => {
    const svc = d.entity('influencer');
    const { row } = applied(svc.create(user, { nickname: '小美' }));
    svc.update(user, row.id, { nickname: '小美' });
    expect(svc.require(row.id).version).toBe(1);
    expect(db.select().from(changeLog).all()).toHaveLength(1);
  });

  it('用户手动改普通字段（阶段、下次跟进日期）直接生效并记日志', () => {
    const { coop } = makeCoop();
    const r = d
      .entity('cooperation')
      .update(user, coop.id, { stage: '洽谈中', nextFollowDate: '2026-10-21' });
    expect(r.status).toBe('applied');
  });
});

describe('乐观锁', () => {
  it('基于旧版本更新判冲突，不覆盖他人修改', () => {
    const svc = d.entity('influencer');
    const { row } = applied(svc.create(user, { nickname: '小美' }));
    svc.update(user, row.id, { rating: 'A' }, { expectedVersion: 1 });
    expect(() => svc.update(user, row.id, { rating: 'B' }, { expectedVersion: 1 })).toThrow(
      expect.objectContaining({ code: 'conflict' }),
    );
    expect(svc.require(row.id).rating).toBe('A');
  });
});

describe('敏感操作进审核队列', () => {
  it('AI 修改佣金：只生成待审核记录，数据库不变', () => {
    const { coop } = makeCoop();
    const prod = applied(
      d.entity('product').create(user, { styleNo: 'A001', name: '羊毛大衣' }),
    ).row;
    const cp = applied(
      d
        .entity('cooperation_product')
        .create(user, { cooperationId: coop.id, productId: prod.id, commissionPct: 20 }),
    ).row;
    const r = d.entity('cooperation_product').update(agent(), cp.id, { commissionPct: 25 });
    expect(r).toMatchObject({ status: 'pending', reason: '修改金额或佣金' });
    expect(d.entity('cooperation_product').require(cp.id).commissionPct).toBe(20);
    expect(d.review.pendingCount()).toBe(1);
    expect(
      db.select().from(changeLog).where(eq(changeLog.entity, 'cooperation_product')).all(),
    ).toHaveLength(1);
  });

  it('AI 的普通字段修改（单条）直接生效；删除、批量修改一律待审核', () => {
    const { coop, inf } = makeCoop();
    expect(d.entity('cooperation').update(agent(), coop.id, { liveSlot: '20:00' }).status).toBe(
      'applied',
    );
    expect(d.entity('influencer').delete(agent(), inf.id).status).toBe('pending');
    const res = d.entity('cooperation').updateMany(agent(), [
      { id: coop.id, patch: { channel: 'a' } },
      { id: coop.id, patch: { channel: 'b' } },
    ]);
    expect(res.every((r) => r.status === 'pending' && r.reason === '批量修改')).toBe(true);
    expect(d.entity('influencer').get(inf.id)).toBeDefined();
  });

  it('修改已完成的合作：AI 走审核，用户直接生效', () => {
    const { coop } = makeCoop({ stage: '完成' });
    expect(d.entity('cooperation').update(agent(), coop.id, { liveSlot: '21:00' })).toMatchObject({
      status: 'pending',
      reason: '修改已完成的合作',
    });
    expect(d.entity('cooperation').update(user, coop.id, { liveSlot: '21:00' }).status).toBe(
      'applied',
    );
  });

  it('导入产生的敏感改动同样进审核', () => {
    const { coop } = makeCoop();
    const imp: Actor = { type: 'import', userId: d.userId, batchId: d.newBatchId() };
    expect(d.entity('cooperation').update(imp, coop.id, { slotFeeCents: 100000 }).status).toBe(
      'pending',
    );
  });

  it('批量改动超过 200 条被拒绝', () => {
    const items = Array.from({ length: 201 }, () => ({ id: 'x', patch: {} }));
    expect(() => d.entity('cooperation').updateMany(agent(), items)).toThrow(/200/);
  });
});

describe('审核：通过 / 驳回 / 冲突', () => {
  it('通过后落库，日志记原操作者与审核人', () => {
    const { coop } = makeCoop();
    const r = d.entity('cooperation').update(agent(), coop.id, { slotFeeCents: 500000 });
    if (r.status !== 'pending') throw new Error('应进入待审核');
    d.review.approve(r.pendingId, d.userId);
    expect(d.entity('cooperation').require(coop.id).slotFeeCents).toBe(500000);
    const log = db
      .select()
      .from(changeLog)
      .where(eq(changeLog.entityId, coop.id))
      .orderBy(changeLog.id)
      .all()
      .at(-1)!;
    expect(log).toMatchObject({ actorType: 'agent', approvedBy: d.userId, source: '测试原文' });
    expect(d.review.pendingCount()).toBe(0);
  });

  it('驳回不落库', () => {
    const { coop } = makeCoop();
    const r = d.entity('cooperation').update(agent(), coop.id, { slotFeeCents: 1 });
    if (r.status !== 'pending') throw new Error();
    d.review.reject(r.pendingId, d.userId);
    expect(d.entity('cooperation').require(coop.id).slotFeeCents).toBeNull();
    expect(() => d.review.approve(r.pendingId, d.userId)).toThrow(/rejected/);
  });

  it('审核时记录已被修改：判冲突不落库，重新确认后可通过', () => {
    const { coop } = makeCoop();
    const r = d.entity('cooperation').update(agent(), coop.id, { slotFeeCents: 500000 });
    if (r.status !== 'pending') throw new Error();
    d.entity('cooperation').update(user, coop.id, { liveSlot: '20:00' });
    expect(() => d.review.approve(r.pendingId, d.userId)).toThrow(
      expect.objectContaining({ code: 'conflict' }),
    );
    expect(d.entity('cooperation').require(coop.id).slotFeeCents).toBeNull();
    expect(
      db.select().from(pendingChanges).where(eq(pendingChanges.id, r.pendingId)).get()!.status,
    ).toBe('conflict');
    d.review.rebase(r.pendingId);
    d.review.approve(r.pendingId, d.userId);
    expect(d.entity('cooperation').require(coop.id).slotFeeCents).toBe(500000);
  });

  it('整批通过', () => {
    const { coop } = makeCoop();
    const batch = d.newBatchId();
    d.entity('cooperation').updateMany(agent(batch), [
      { id: coop.id, patch: { channel: 'a' } },
      { id: coop.id, patch: { reportStatus: 'b' } },
    ]);
    const first = d.review.approveBatch(batch, d.userId);
    // 同一条记录的两个补丁基于同一版本：第一条通过后第二条判冲突，符合预期
    expect(first.approved).toHaveLength(1);
    expect(first.conflicts).toHaveLength(1);
  });
});

describe('撤销', () => {
  it('撤销创建 = 软删除；撤销修改 = 恢复旧值；撤销删除 = 恢复记录', () => {
    const svc = d.entity('influencer');
    const created = applied(svc.create(user, { nickname: '小美' }));
    d.review.undo(user, created.logId);
    expect(svc.get(created.row.id)).toBeUndefined();

    const b = applied(svc.create(user, { nickname: '小红', rating: 'A' }));
    const upd = applied(svc.update(user, b.row.id, { rating: 'B', nickname: '小红2' }));
    d.review.undo(user, upd.logId);
    expect(svc.require(b.row.id)).toMatchObject({ rating: 'A', nickname: '小红' });

    const del = applied(svc.delete(user, b.row.id));
    d.review.undo(user, del.logId);
    expect(svc.get(b.row.id)).toBeDefined();
  });

  it('撤销本身写日志，原日志标记已撤销，不能重复撤销', () => {
    const svc = d.entity('influencer');
    const c = applied(svc.create(user, { nickname: '小美' }));
    const upd = applied(svc.update(user, c.row.id, { rating: 'B' }));
    d.review.undo(user, upd.logId);
    const logs = db.select().from(changeLog).where(eq(changeLog.entityId, c.row.id)).all();
    expect(logs).toHaveLength(3);
    expect(logs.find((l) => l.id === upd.logId)!.revertedAt).not.toBeNull();
    expect(logs.find((l) => l.undoOf === upd.logId)).toBeDefined();
    expect(() => d.review.undo(user, upd.logId)).toThrow(/已被撤销/);
  });

  it('记录之后又被改过：撤销判冲突，数据不变', () => {
    const svc = d.entity('influencer');
    const c = applied(svc.create(user, { nickname: '小美' }));
    const first = applied(svc.update(user, c.row.id, { rating: 'B' }));
    svc.update(user, c.row.id, { rating: 'C' });
    expect(() => d.review.undo(user, first.logId)).toThrow(
      expect.objectContaining({ code: 'conflict' }),
    );
    expect(svc.require(c.row.id).rating).toBe('C');
  });

  it('整批撤销：逆序撤销；有冲突的记录单独标出', () => {
    const batch = d.newBatchId();
    const imp: Actor = { type: 'import', userId: d.userId, batchId: batch };
    const svc = d.entity('influencer');
    const a = applied(svc.create(imp, { nickname: 'A' })).row;
    const b = applied(svc.create(imp, { nickname: 'B' })).row;
    svc.update(user, b.id, { rating: '导入后手动改过' });
    const res = d.review.undoBatch(user, batch);
    expect(res.undone).toHaveLength(1);
    expect(res.conflicts).toHaveLength(1);
    expect(svc.get(a.id)).toBeUndefined();
    expect(svc.get(b.id)).toBeDefined();
  });
});

describe('AI 提出的修改一律进审核（propose）', () => {
  it('普通字段也不直接生效；带警告；审核通过后才落库', () => {
    const { coop } = makeCoop();
    const r = d
      .entity('cooperation')
      .propose(agent(), coop.id, { liveSlot: '20:00' }, { warnings: ['测试警告'] });
    expect(r).toMatchObject({ status: 'pending', reason: 'AI 提出的修改' });
    expect(d.entity('cooperation').require(coop.id).liveSlot).toBeNull();
    const p = d.reviewView.listPending()[0]!;
    expect(p.warnings).toEqual(['测试警告']);
    d.review.approve((r as { pendingId: string }).pendingId, d.userId);
    expect(d.entity('cooperation').require(coop.id).liveSlot).toBe('20:00');
  });

  it('敏感字段给出具体原因；提出时就校验业务规则（流失必须有原因）', () => {
    const { coop } = makeCoop();
    expect(d.entity('cooperation').propose(agent(), coop.id, { slotFeeCents: 1000 })).toMatchObject(
      { reason: '修改金额' },
    );
    expect(() => d.entity('cooperation').propose(agent(), coop.id, { stage: '流失' })).toThrow(
      /原因/,
    );
    expect(() => d.entity('cooperation').propose(agent(), coop.id, { realName: 'x' })).toThrow(
      DomainError,
    );
  });

  it('proposeDelete 生成待审核的删除', () => {
    const { inf } = makeCoop();
    expect(d.entity('influencer').proposeDelete(agent(), inf.id)).toMatchObject({
      status: 'pending',
      reason: '删除',
    });
    expect(d.entity('influencer').get(inf.id)).toBeDefined();
  });

  it('审核卡片上改字段再确认：改完重新校验，标记已由用户修改；改错的被拒绝', () => {
    const { coop } = makeCoop();
    const r = d.entity('cooperation').propose(agent(), coop.id, { slotFeeCents: 100000 }) as {
      pendingId: string;
    };
    expect(() => d.review.editPatch(r.pendingId, { stage: '流失' })).toThrow(/原因/);
    d.review.editPatch(r.pendingId, { slotFeeCents: 80000 });
    const p = d.reviewView.listPending().find((x) => x.id === r.pendingId)!;
    expect(p.diff.find((x) => x.field === 'slotFeeCents')!.after).toBe(80000);
    expect(p.warnings).toContain('已由用户在审核时修改');
    d.review.approve(r.pendingId, d.userId);
    expect(d.entity('cooperation').require(coop.id).slotFeeCents).toBe(80000);
    expect(() => d.review.editPatch(r.pendingId, { slotFeeCents: 1 })).toThrow(/approved/);
  });
});

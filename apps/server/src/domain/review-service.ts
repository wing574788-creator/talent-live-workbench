import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/index.ts';
import { changeLog, pendingChanges } from '../db/schema.ts';
import { DomainError, notFound } from './errors.ts';
import { newId, type ServiceRegistry } from './entity-service.ts';
import type { Actor, WriteResult } from './types.ts';

const nowIso = () => new Date().toISOString();

/** 审核队列：通过 / 驳回 / 冲突重新确认；以及按条或按批撤销。 */
export class ReviewService {
  constructor(
    private readonly db: Db,
    private readonly registry: ServiceRegistry,
  ) {}

  listPending(status: 'pending' | 'conflict' = 'pending') {
    return this.db
      .select()
      .from(pendingChanges)
      .where(eq(pendingChanges.status, status))
      .orderBy(desc(pendingChanges.id))
      .all();
  }

  pendingCount(): number {
    return this.listPending('pending').length;
  }

  /** 通过：记录已被修改则判冲突，不落库，需要重新确认（rebase）。 */
  approve(pendingId: string, reviewerId: string): WriteResult {
    const pending = this.requirePending(pendingId, ['pending']);
    const service = this.registry.get(pending.entity);
    let result: WriteResult;
    try {
      result = this.db.transaction(() => {
        const res = service.applyApproved(pending, reviewerId);
        this.db
          .update(pendingChanges)
          .set({ status: 'approved', reviewedAt: nowIso(), reviewedBy: reviewerId })
          .where(eq(pendingChanges.id, pendingId))
          .run();
        return res;
      });
    } catch (err) {
      if (err instanceof DomainError && err.code === 'conflict') {
        this.db
          .update(pendingChanges)
          .set({ status: 'conflict' })
          .where(eq(pendingChanges.id, pendingId))
          .run();
      }
      throw err;
    }
    return result;
  }

  approveBatch(batchId: string, reviewerId: string) {
    const items = this.db
      .select()
      .from(pendingChanges)
      .where(and(eq(pendingChanges.batchId, batchId), eq(pendingChanges.status, 'pending')))
      .all();
    const approved: string[] = [];
    const conflicts: string[] = [];
    for (const p of items) {
      try {
        this.approve(p.id, reviewerId);
        approved.push(p.id);
      } catch (err) {
        if (err instanceof DomainError && err.code === 'conflict') conflicts.push(p.id);
        else throw err;
      }
    }
    return { approved, conflicts };
  }

  reject(pendingId: string, reviewerId: string) {
    this.requirePending(pendingId, ['pending', 'conflict']);
    this.db
      .update(pendingChanges)
      .set({ status: 'rejected', reviewedAt: nowIso(), reviewedBy: reviewerId })
      .where(eq(pendingChanges.id, pendingId))
      .run();
  }

  /** 整批驳回：只处理还在待审核的 */
  rejectBatch(batchId: string, reviewerId: string): string[] {
    const items = this.db
      .select()
      .from(pendingChanges)
      .where(and(eq(pendingChanges.batchId, batchId), eq(pendingChanges.status, 'pending')))
      .all();
    for (const p of items) this.reject(p.id, reviewerId);
    return items.map((p) => p.id);
  }

  /**
   * 审核卡片上直接改字段再确认：只能改还在待审核的更新类改动；改完重新校验，标记"用户已修改"。
   * 改动人是用户本人，所以不再要求和原文逐字核对。
   */
  editPatch(pendingId: string, patch: Record<string, unknown>) {
    const pending = this.requirePending(pendingId, ['pending']);
    if (pending.action !== 'update')
      throw new DomainError('invalid_state', '只有修改类的待审核改动可以编辑');
    const svc = this.registry.get(pending.entity);
    const before = svc.require(pending.entityId);
    const merged = { ...((pending.patch ?? {}) as Record<string, unknown>), ...patch };
    const data = svc.checkPatch(before, merged);
    const warnings = [...new Set([...(pending.warnings ?? []), '已由用户在审核时修改'])];
    this.db
      .update(pendingChanges)
      .set({ patch: data, warnings })
      .where(eq(pendingChanges.id, pendingId))
      .run();
    return data;
  }

  /** 冲突后重新确认：以记录当前版本为基准重新生成对比，回到待审核。 */
  rebase(pendingId: string) {
    const pending = this.requirePending(pendingId, ['pending', 'conflict']);
    const current = this.registry.get(pending.entity).require(pending.entityId);
    // 合并还要把被合并方的版本一并刷新
    let patch = pending.patch;
    if (pending.action === 'merge') {
      const mergeId = (pending.patch as { mergeId: string }).mergeId;
      patch = {
        ...(pending.patch as object),
        mergeVersion: this.registry.get('influencer').require(mergeId).version,
      };
    }
    this.db
      .update(pendingChanges)
      .set({ status: 'pending', baseVersion: current.version, before: current, patch })
      .where(eq(pendingChanges.id, pendingId))
      .run();
  }

  private requirePending(id: string, allowed: string[]) {
    const p = this.db.select().from(pendingChanges).where(eq(pendingChanges.id, id)).get();
    if (!p) throw notFound('待审核改动');
    if (!allowed.includes(p.status)) {
      throw new DomainError('invalid_state', `待审核改动当前状态为 ${p.status}`);
    }
    return p;
  }

  // ───────────── 撤销 ─────────────
  undo(actor: Actor, logId: string): WriteResult {
    const log = this.db.select().from(changeLog).where(eq(changeLog.id, logId)).get();
    if (!log) throw notFound('变更日志');
    return this.registry.get(log.entity).undoLog(actor, logId);
  }

  /** 整批撤销：逆序逐条撤销；某条记录之后又被改过的标为冲突，其余照常撤销。 */
  undoBatch(actor: Actor, batchId: string) {
    const logs = this.db
      .select()
      .from(changeLog)
      .where(eq(changeLog.batchId, batchId))
      .orderBy(desc(changeLog.id))
      .all()
      .filter((l) => !l.revertedAt && !l.undoOf);
    const undone: string[] = [];
    const conflicts: string[] = [];
    // 撤销产生的新日志沿用独立批次号，避免与原批次混在一起
    const undoActor: Actor = { ...actor, batchId: actor.batchId ?? newId() };
    for (const l of logs) {
      try {
        this.registry.get(l.entity).undoLog(undoActor, l.id);
        undone.push(l.id);
      } catch (err) {
        if (err instanceof DomainError && err.code === 'conflict') conflicts.push(l.id);
        else throw err;
      }
    }
    return { undone, conflicts, undoBatchId: undoActor.batchId! };
  }
}

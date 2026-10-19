import { and, count, desc, eq, inArray, lt } from 'drizzle-orm';
import { SENSITIVE_FIELDS, maskRow } from '@workbench/shared';
import type { Db } from '../db/index.ts';
import { changeLog, pendingChanges } from '../db/schema.ts';
import type { ServiceRegistry } from './entity-service.ts';
import type { Row } from './types.ts';

/** 日志对比里不展示的系统字段 */
const SKIP = new Set([
  'id',
  'createdAt',
  'updatedAt',
  'createdBy',
  'ownerId',
  'version',
  'deletedAt',
]);

const sensitiveOf = (entity: string): readonly string[] =>
  (SENSITIVE_FIELDS as Record<string, readonly string[]>)[entity] ?? [];

/** 字段值打码：敏感字段（微信、手机、地址、真实姓名）永远不出现在审核和日志的响应里 */
function maskValue(entity: string, field: string, value: unknown): unknown {
  if (value == null || !sensitiveOf(entity).includes(field)) return value;
  return maskRow({ [field]: value }, sensitiveOf(entity))[field];
}

export interface FieldDiff {
  field: string;
  before: unknown;
  after: unknown;
  /** 审核列表里：记录现在的值（和提出时不同说明记录已被改过） */
  current?: unknown;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** 审核页和变更日志页的只读视图。 */
export class ReviewView {
  constructor(
    private readonly db: Db,
    private readonly reg: ServiceRegistry,
  ) {}

  /** 外键字段 → 它指向的实体 */
  private static REFS: Record<string, string> = {
    influencerId: 'influencer',
    productId: 'product',
    cooperationId: 'cooperation',
    contactId: 'contact',
    platformAccountId: 'platform_account',
  };

  /** 展示用的值：敏感字段打码；外键换成名称（被删除的记录也能显示） */
  private shown(entity: string, field: string, value: unknown): unknown {
    const refEntity = ReviewView.REFS[field];
    if (refEntity && typeof value === 'string') {
      const row = this.reg.get(refEntity).peek(value);
      return row ? this.displayName(refEntity, row) : '（未知）';
    }
    return maskValue(entity, field, value);
  }

  /** 记录的可读名称：达人昵称、商品款号+名称、合作的达人+阶段…… */
  displayName(entity: string, row: Row | Record<string, unknown> | null | undefined): string {
    if (!row) return '（未知）';
    const get = (e: string, id: unknown) => (id ? this.reg.get(e).peek(id as string) : undefined);
    switch (entity) {
      case 'influencer':
        return String(row.nickname);
      case 'contact':
        return String(row.name);
      case 'product':
        return `${row.styleNo} ${row.name}`;
      case 'cooperation':
        return `${get('influencer', row.influencerId)?.nickname ?? '（已删除）'} · ${row.stage}`;
      case 'cooperation_product': {
        const p = get('product', row.productId);
        const c = get('cooperation', row.cooperationId);
        return `${p ? `${p.styleNo} ${p.name}` : '商品'} @ ${get('influencer', c?.influencerId)?.nickname ?? '合作'}`;
      }
      case 'platform_account':
        return `${row.platform} ${row.accountId}`;
      case 'sample_shipment':
      case 'sample_return':
      case 'sample_writeoff':
        return `${get('influencer', row.influencerId)?.nickname ?? '达人'} 的样品单`;
      case 'sample_shipment_item':
      case 'sample_return_item':
        return `${row.styleNo} ${row.color} ${row.size} ×${row.qty}`;
      case 'follow_up':
        return String(row.summary).slice(0, 20);
      case 'field_def':
        return String(row.label);
      default:
        return String(row.name ?? row.nickname ?? row.id);
    }
  }

  private diff(entity: string, before: Row | null, after: Row | null): FieldDiff[] {
    const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
    return [...keys]
      .filter((k) => !SKIP.has(k) && !same(before?.[k], after?.[k]))
      .map((k) => ({
        field: k,
        before: this.shown(entity, k, before?.[k] ?? null),
        after: this.shown(entity, k, after?.[k] ?? null),
      }));
  }

  // ───────────── 审核列表 ─────────────
  listPending() {
    const rows = this.db
      .select()
      .from(pendingChanges)
      .where(inArray(pendingChanges.status, ['pending', 'conflict']))
      .orderBy(desc(pendingChanges.id))
      .all();
    const batchCount = new Map<string, number>();
    for (const r of rows)
      if (r.batchId) batchCount.set(r.batchId, (batchCount.get(r.batchId) ?? 0) + 1);
    return rows.map((p) => {
      const before = p.before as Row | null;
      const current = this.reg.get(p.entity).get(p.entityId);
      // 冲突检测：记录在提出改动后又被改过（或已被删除）
      const patch = (p.patch ?? {}) as Record<string, unknown>;
      const mergeCurrent =
        p.action === 'merge' ? this.reg.get('influencer').get(String(patch.mergeId)) : undefined;
      const stale =
        p.status === 'conflict' ||
        !current ||
        current.version !== p.baseVersion ||
        (p.action === 'merge' && (!mergeCurrent || mergeCurrent.version !== patch.mergeVersion));
      const diff: FieldDiff[] =
        p.action === 'update'
          ? Object.keys(patch)
              .filter((k) => !same(before?.[k], patch[k]))
              .map((k) => ({
                field: k,
                before: this.shown(p.entity, k, before?.[k] ?? null),
                after: this.shown(p.entity, k, patch[k]),
                current:
                  current && !same(current[k], before?.[k])
                    ? this.shown(p.entity, k, current[k])
                    : undefined,
              }))
          : [];
      return {
        id: p.id,
        entity: p.entity,
        entityId: p.entityId,
        action: p.action,
        status: p.status,
        reason: p.reason,
        warnings: p.warnings ?? [],
        actorType: p.actorType,
        source: p.source,
        batchId: p.batchId,
        batchSize: p.batchId ? batchCount.get(p.batchId)! : 1,
        createdAt: p.createdAt,
        target: this.displayName(p.entity, before),
        stale,
        staleReason: !current
          ? '记录已被删除'
          : stale
            ? '记录在提出改动后已被修改，需要重新确认'
            : null,
        diff,
        merge:
          p.action === 'merge'
            ? { mergeNickname: (patch as { mergeNickname?: string }).mergeNickname ?? '' }
            : null,
      };
    });
  }

  // ───────────── 变更日志 ─────────────
  listChanges(opts: {
    entity?: string;
    actorType?: string;
    batchId?: string;
    before?: string;
    limit?: number;
  }) {
    const limit = Math.min(opts.limit ?? 50, 200);
    const conds = [
      opts.entity ? eq(changeLog.entity, opts.entity) : undefined,
      opts.actorType ? eq(changeLog.actorType, opts.actorType) : undefined,
      opts.batchId ? eq(changeLog.batchId, opts.batchId) : undefined,
      opts.before ? lt(changeLog.id, opts.before) : undefined,
    ].filter(Boolean);
    const rows = this.db
      .select()
      .from(changeLog)
      .where(conds.length ? and(...(conds as never[])) : undefined)
      .orderBy(desc(changeLog.id))
      .limit(limit)
      .all();
    const ids = [...new Set(rows.map((r) => r.batchId).filter((b): b is string => !!b))];
    const sizes = new Map<string, { total: number }>();
    if (ids.length) {
      const totals = this.db
        .select({ b: changeLog.batchId, n: count() })
        .from(changeLog)
        .where(inArray(changeLog.batchId, ids))
        .groupBy(changeLog.batchId)
        .all();
      for (const t of totals) sizes.set(t.b!, { total: t.n });
    }
    return {
      rows: rows.map((l) => {
        const before = l.before as Row | null;
        const after = l.after as Row | null;
        const restored = l.action === 'update' && !!before?.deletedAt && !after?.deletedAt;
        return {
          id: l.id,
          entity: l.entity,
          entityId: l.entityId,
          action: restored ? 'restore' : l.action,
          actorType: l.actorType,
          approvedBy: l.approvedBy,
          batchId: l.batchId,
          batchSize: l.batchId ? (sizes.get(l.batchId)?.total ?? 1) : 1,
          undoOf: l.undoOf,
          revertedAt: l.revertedAt,
          source: l.source,
          createdAt: l.createdAt,
          target: this.displayName(l.entity, after ?? before),
          changes: l.action === 'update' && !restored ? this.diff(l.entity, before, after) : [],
        };
      }),
      next: rows.length === limit ? rows[rows.length - 1]!.id : null,
    };
  }
}

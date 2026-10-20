/**
 * 领域服务基类：所有写入的唯一入口（CLAUDE.md 铁律 1~3）。
 * 校验、乐观锁、变更日志、敏感操作转审核、撤销都只在这里实现一次。
 * 路由和 Agent 工具不写 SQL，只调用这里的方法。
 *
 * better-sqlite3 是同步驱动，每个写操作在一个事务里完成。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { and, asc, desc, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import { getTableColumns } from 'drizzle-orm';
import { monotonicFactory } from 'ulid';
import { z } from 'zod';
import type { Db } from '../db/index.ts';
import { changeLog, fieldDefs, pendingChanges, type AnyTable } from '../db/schema.ts';
import { DomainError, conflict, notFound } from './errors.ts';
import {
  MAX_BATCH,
  type Actor,
  type Row,
  type SensitivityRule,
  type WriteResult,
} from './types.ts';

export const newId = monotonicFactory();
const nowIso = () => new Date().toISOString();

/** 补丁里不允许出现的系统字段 */
const SYSTEM_FIELDS = new Set([
  'id',
  'createdAt',
  'updatedAt',
  'createdBy',
  'version',
  'deletedAt',
]);

export interface EntityConfig {
  /** 实体名，写入 change_log.entity */
  name: string;
  table: AnyTable;
  schema: z.ZodObject<z.ZodRawShape>;
  sensitivity?: SensitivityRule;
  /** 关键字搜索覆盖的列（属性名） */
  searchFields?: string[];
  /** 允许用于精确筛选的列 */
  filterFields?: string[];
  /** 允许排序的列 */
  sortFields?: string[];
  /** 业务状态校验：next 是改动后的完整状态；不合法时抛 DomainError。创建、修改、审核通过时调用。 */
  validateState?: (next: Record<string, unknown>, before: Row | undefined) => void;
  /**
   * 修改前的联动补丁：根据改动前状态和本次补丁，返回需要一并写入的字段（如离开洽谈中时清空跟进字段）。
   * 在校验之前合并进补丁，所以同样进变更日志、同样可撤销。
   */
  normalizePatch?: (before: Row, patch: Record<string, unknown>) => Record<string, unknown> | void;
  /** 写入落库后（同一事务内）的联动，如阶段自动推进。 */
  afterWrite?: (e: WriteEvent) => void;
}

/** 一次已落库的写入（含撤销产生的写入），供 afterWrite 钩子使用 */
export interface WriteEvent {
  action: 'create' | 'update' | 'delete';
  before: Row | null;
  after: Row;
  actor: Actor;
  /** 由撤销产生 */
  undo: boolean;
}

export interface QueryOptions {
  q?: string;
  filters?: Record<string, string>;
  /** 自定义字段精确筛选：{ 字段键: 值 } */
  custom?: Record<string, string>;
  sort?: string;
  dir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface ServiceRegistry {
  get(entity: string): EntityService;
}

export class EntityService {
  readonly name: string;
  protected readonly table: AnyTable;
  protected readonly cols: Record<string, any>;
  protected readonly patchSchema: z.ZodTypeAny;

  constructor(
    protected readonly db: Db,
    protected readonly config: EntityConfig,
    protected readonly registry: ServiceRegistry,
  ) {
    this.name = config.name;
    this.table = config.table;
    this.cols = getTableColumns(config.table);
    const shape: z.ZodRawShape = {};
    for (const [k, v] of Object.entries(config.schema.shape)) {
      shape[k] = (v instanceof z.ZodDefault ? v.removeDefault() : v).optional();
    }
    this.patchSchema = z.object(shape).strict();
  }

  // ───────────── 读 ─────────────
  get(id: string): Row | undefined {
    return this.db
      .select()
      .from(this.table)
      .where(and(eq(this.cols.id, id), isNull(this.cols.deletedAt)))
      .get() as Row | undefined;
  }

  require(id: string): Row {
    const row = this.get(id);
    if (!row) throw notFound(this.name);
    return row;
  }

  /** 按 id 取记录，包括已软删除的（审核和日志里要显示被删除记录的名称）。 */
  peek(id: string): Row | undefined {
    return this.db.select().from(this.table).where(eq(this.cols.id, id)).get() as Row | undefined;
  }

  /** 按外键等列精确查找（未删除）。列名必须是本表的列。 */
  findBy(field: string, value: string): Row[] {
    const col = this.cols[field];
    if (!col) throw new Error(`未知列：${field}`);
    return this.db
      .select()
      .from(this.table)
      .where(and(eq(col, value), isNull(this.cols.deletedAt)))
      .all() as Row[];
  }

  list(): Row[] {
    return this.db.select().from(this.table).where(isNull(this.cols.deletedAt)).all() as Row[];
  }

  /** 列表查询：关键字、精确筛选、自定义字段筛选、排序、分页。列名全部走白名单，不拼接用户输入。 */
  query(opts: QueryOptions = {}, extraWhere?: SQL): { rows: Row[]; total: number } {
    const conds: (SQL | undefined)[] = [isNull(this.cols.deletedAt), extraWhere];
    const q = opts.q?.trim();
    if (q && this.config.searchFields?.length) {
      const pattern = `%${q.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
      conds.push(
        or(
          ...this.config.searchFields.map((f) => sql`${this.cols[f]} like ${pattern} escape '\\'`),
        ),
      );
    }
    for (const [f, v] of Object.entries(opts.filters ?? {})) {
      if (!this.config.filterFields?.includes(f)) {
        throw new DomainError('validation', `不支持按 ${f} 筛选`);
      }
      conds.push(eq(this.cols[f], v));
    }
    for (const [k, v] of Object.entries(opts.custom ?? {})) {
      if (!/^[a-z][a-z0-9_]*$/.test(k)) throw new DomainError('validation', '自定义字段键不合法');
      conds.push(sql`json_extract(${this.cols.custom}, ${'$.' + k}) = ${v}`);
    }
    const where = and(...conds);
    const total = this.db
      .select({ n: sql<number>`count(*)` })
      .from(this.table)
      .where(where)
      .get()!.n;
    let order: SQL = desc(this.cols.id);
    if (opts.sort) {
      if (!this.config.sortFields?.includes(opts.sort)) {
        throw new DomainError('validation', `不支持按 ${opts.sort} 排序`);
      }
      order = (opts.dir === 'desc' ? desc : asc)(this.cols[opts.sort]);
    }
    const rows = this.db
      .select()
      .from(this.table)
      .where(where)
      .orderBy(order)
      .limit(Math.min(opts.limit ?? 50, 500))
      .offset(opts.offset ?? 0)
      .all() as Row[];
    return { rows, total };
  }

  /** 自定义字段值校验：键必须在 field_defs 里定义过，类型要对得上。 */
  protected validateCustom(custom: unknown): void {
    if (custom == null) return;
    const defs = this.db
      .select()
      .from(fieldDefs)
      .where(and(eq(fieldDefs.entity, this.name), isNull(fieldDefs.deletedAt)))
      .all();
    const byKey = new Map(defs.map((d) => [d.key, d]));
    for (const [k, v] of Object.entries(custom as Record<string, unknown>)) {
      const def = byKey.get(k);
      if (!def) throw new DomainError('validation', `未定义的自定义字段：${k}`);
      if (v == null || v === '') continue;
      const bad = (what: string) =>
        new DomainError('validation', `自定义字段「${def.label}」应为${what}`);
      switch (def.type) {
        case 'number':
          if (typeof v !== 'number' || !Number.isFinite(v)) throw bad('数字');
          break;
        case 'bool':
          if (typeof v !== 'boolean') throw bad('是/否');
          break;
        case 'date':
          if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v))
            throw bad('日期（YYYY-MM-DD）');
          break;
        case 'select':
          if (typeof v !== 'string' || (def.options && !def.options.includes(v)))
            throw bad('选项之一');
          break;
        case 'multiselect':
          if (
            !Array.isArray(v) ||
            v.some((x) => typeof x !== 'string' || (def.options && !def.options.includes(x)))
          )
            throw bad('选项（多选）');
          break;
        default:
          if (typeof v !== 'string') throw bad('文本');
      }
    }
  }

  // ───────────── 写：创建 ─────────────
  /** 新增是低风险写：校验后直接写入并记日志（可撤销）。 */
  create(actor: Actor, input: unknown): WriteResult {
    const data = this.parse(this.config.schema, input);
    this.validateCustom((data as any).custom);
    this.config.validateState?.(data as Record<string, unknown>, undefined);
    return this.tx(() => this.insertRow(actor, data));
  }

  // ───────────── 写：修改 ─────────────
  update(
    actor: Actor,
    id: string,
    patch: unknown,
    opts: { expectedVersion?: number } = {},
  ): WriteResult {
    const data = this.parsePatch(patch);
    this.validateCustom(data.custom);
    return this.tx(() => {
      const before = this.require(id);
      if (opts.expectedVersion !== undefined && opts.expectedVersion !== before.version) {
        throw conflict(
          `${this.name}已被修改（当前版本 ${before.version}，你基于 ${opts.expectedVersion}）`,
        );
      }
      this.assertValid(before, data);
      const reason = this.reviewReason(actor, 'update', before, data);
      if (reason) return this.queue(actor, 'update', before, data, reason);
      return this.applyUpdate(actor, before, data);
    });
  }

  /**
   * 批量修改：来自 AI/导入且多于一条时，整批都只生成待审核记录（"批量修改"属于敏感操作）。
   * 用户手动批量操作直接生效。
   */
  updateMany(actor: Actor, items: { id: string; patch: unknown }[]): WriteResult[] {
    if (items.length > MAX_BATCH) {
      throw new DomainError('validation', `单次批量改动不能超过 ${MAX_BATCH} 条`);
    }
    const forceReview = actor.type !== 'user' && items.length > 1;
    return this.tx(() =>
      items.map(({ id, patch }) => {
        const data = this.parsePatch(patch);
        const before = this.require(id);
        this.assertValid(before, data);
        const reason = forceReview ? '批量修改' : this.reviewReason(actor, 'update', before, data);
        if (reason) return this.queue(actor, 'update', before, data, reason);
        return this.applyUpdate(actor, before, data);
      }),
    );
  }

  /**
   * 提出修改：无论敏感与否都只生成待审核记录（PRD 5.6："AI 提出的修改一律需要审核"）。
   * AI 工具走这里；用户在页面上手动改仍然走 update（直接生效，记日志）。
   */
  propose(
    actor: Actor,
    id: string,
    patch: unknown,
    opts: { reason?: string; warnings?: string[] } = {},
  ): WriteResult {
    const data = this.parsePatch(patch);
    this.validateCustom(data.custom);
    return this.tx(() => {
      const before = this.require(id);
      this.assertValid(before, data);
      const reason =
        opts.reason ??
        this.config.sensitivity?.({ action: 'update', before, patch: data }) ??
        'AI 提出的修改';
      return this.queue(actor, 'update', before, data, reason, opts.warnings);
    });
  }

  /** 校验一个补丁对这条记录是否成立（字段、类型、业务规则），返回规范化后的补丁 */
  checkPatch(before: Row, patch: unknown): Record<string, unknown> {
    const data = this.parsePatch(patch);
    this.validateCustom(data.custom);
    this.assertValid(before, data);
    return data;
  }

  proposeDelete(actor: Actor, id: string, warnings?: string[]): WriteResult {
    return this.tx(() =>
      this.queue(actor, 'delete', this.require(id), undefined, '删除', warnings),
    );
  }

  // ───────────── 写：删除（软删除） ─────────────
  delete(actor: Actor, id: string, opts: { expectedVersion?: number } = {}): WriteResult {
    return this.tx(() => {
      const before = this.require(id);
      if (opts.expectedVersion !== undefined && opts.expectedVersion !== before.version) {
        throw conflict(`${this.name}已被修改`);
      }
      const reason = this.reviewReason(actor, 'delete', before);
      if (reason) return this.queue(actor, 'delete', before, undefined, reason);
      return this.applyDelete(actor, before);
    });
  }

  // ───────────── 审核队列：通过 ─────────────
  /** 由审核服务调用：重新校验行版本，通过后以原操作者身份落库（日志里记审核人）。 */
  applyApproved(pending: typeof pendingChanges.$inferSelect, reviewerId: string): WriteResult {
    const before = this.get(pending.entityId);
    if (!before) throw notFound(this.name);
    if (before.version !== pending.baseVersion) {
      throw conflict('记录在提出改动后已被修改，需要重新确认', {
        baseVersion: pending.baseVersion,
        currentVersion: before.version,
      });
    }
    const actor: Actor = {
      type: pending.actorType as Actor['type'],
      userId: reviewerId,
      batchId: pending.batchId ?? undefined,
      source: pending.source ?? undefined,
    };
    if (pending.action === 'delete') return this.applyDelete(actor, before, reviewerId);
    const patch = this.parsePatch(pending.patch ?? {});
    this.assertValid(before, patch);
    return this.applyUpdate(actor, before, patch, reviewerId);
  }

  // ───────────── 撤销 ─────────────
  /** 撤销一条日志：只有记录自该日志之后未被改动过才能撤销，否则判为冲突。 */
  undoLog(actor: Actor, logId: string): WriteResult {
    return this.tx(() => {
      const log = this.db.select().from(changeLog).where(eq(changeLog.id, logId)).get();
      if (!log || log.entity !== this.name) throw notFound('变更日志');
      if (log.revertedAt) throw new DomainError('invalid_state', '该改动已被撤销');
      if (log.undoOf) throw new DomainError('invalid_state', '撤销记录本身不能再撤销');

      const current = this.db
        .select()
        .from(this.table)
        .where(eq(this.cols.id, log.entityId))
        .get() as Row | undefined;
      const after = log.after as Row | null;
      const before = log.before as Row | null;
      if (!current) throw notFound(this.name);
      if (after && current.version !== after.version) {
        throw conflict('记录在该改动之后又被修改过，无法直接撤销', {
          expectedVersion: after.version,
          currentVersion: current.version,
        });
      }

      let result: WriteResult;
      const undoActor: Actor = { ...actor, batchId: actor.batchId };
      if (log.action === 'create') {
        result = this.applyDelete(undoActor, current, undefined, log.id);
      } else if (log.action === 'delete') {
        result = this.applyRestore(undoActor, current, log.id);
      } else {
        const revert: Record<string, unknown> = {};
        for (const key of Object.keys(before ?? {})) {
          if (SYSTEM_FIELDS.has(key)) continue;
          if (JSON.stringify(before![key]) !== JSON.stringify(after![key]))
            revert[key] = before![key];
        }
        result = this.applyUpdate(undoActor, current, revert, undefined, log.id);
      }
      this.db.update(changeLog).set({ revertedAt: nowIso() }).where(eq(changeLog.id, log.id)).run();
      return result;
    });
  }

  // ───────────── 内部实现 ─────────────
  protected tx<T>(fn: () => T): T {
    return this.db.transaction(() => fn());
  }

  protected parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> {
    const res = schema.safeParse(input);
    if (!res.success) {
      const msg = res.error.issues
        .map((i) => `${i.path.join('.') || '(根)'}：${i.message}`)
        .join('；');
      throw new DomainError('validation', `${this.name}校验失败：${msg}`, res.error.issues);
    }
    return res.data;
  }

  /** 补丁：schema 的 partial 版本，去掉 default，避免没传的字段被默认值覆盖。 */
  protected parsePatch(patch: unknown): Record<string, unknown> {
    const data = this.parse(this.patchSchema, patch) as Record<string, unknown>;
    for (const k of Object.keys(data)) {
      if (SYSTEM_FIELDS.has(k)) throw new DomainError('validation', `不能修改系统字段 ${k}`);
    }
    return data;
  }

  protected reviewReason(
    actor: Actor,
    action: 'update' | 'delete',
    before: Row,
    patch?: Record<string, unknown>,
  ): string | undefined {
    if (actor.type === 'user') return undefined; // 用户在界面上手动操作直接生效（仍记日志）
    if (action === 'delete') return '删除';
    return this.config.sensitivity?.({ action, before, patch });
  }

  protected queue(
    actor: Actor,
    action: 'update' | 'delete' | 'merge',
    before: Row,
    patch: Record<string, unknown> | undefined,
    reason: string,
    warnings?: string[],
  ): WriteResult {
    const id = newId();
    this.db
      .insert(pendingChanges)
      .values({
        id,
        entity: this.name,
        entityId: before.id,
        action,
        patch: patch ?? null,
        before,
        baseVersion: before.version,
        reason,
        warnings: warnings?.length ? warnings : null,
        actorType: actor.type,
        actorId: actor.userId,
        batchId: actor.batchId ?? null,
        source: actor.source ?? null,
        createdBy: actor.userId,
        ownerId: actor.userId,
      })
      .run();
    return { status: 'pending', pendingId: id, reason };
  }

  /** 先合并联动补丁（会就地修改 patch），再校验改动后的完整状态 */
  protected assertValid(before: Row, patch: Record<string, unknown>) {
    const extra = this.config.normalizePatch?.(before, patch);
    if (extra) Object.assign(patch, extra);
    this.config.validateState?.({ ...before, ...patch }, before);
  }

  protected emit(e: Omit<WriteEvent, 'undo'> & { undoOf?: string }) {
    this.config.afterWrite?.({ ...e, undo: !!e.undoOf });
  }

  protected insertRow(actor: Actor, data: Record<string, unknown>): WriteResult {
    const id = newId();
    const ts = nowIso();
    const values = {
      ...data,
      id,
      createdAt: ts,
      updatedAt: ts,
      createdBy: actor.userId,
      ownerId: actor.userId,
      version: 1,
      deletedAt: null,
    };
    try {
      this.db.insert(this.table).values(values).run();
    } catch (err) {
      throw this.mapDbError(err);
    }
    const row = this.require(id);
    const logId = this.log(actor, 'create', id, null, row);
    this.emit({ action: 'create', before: null, after: row, actor });
    return { status: 'applied', row, logId };
  }

  protected applyUpdate(
    actor: Actor,
    before: Row,
    patch: Record<string, unknown>,
    approvedBy?: string,
    undoOf?: string,
  ): WriteResult {
    const changed = Object.keys(patch).filter(
      (k) => JSON.stringify(patch[k] ?? null) !== JSON.stringify(before[k] ?? null),
    );
    if (changed.length === 0) {
      // 没有实际变化：不写日志、不涨版本
      return { status: 'applied', row: before, logId: '' };
    }
    const set: Record<string, unknown> = { updatedAt: nowIso(), version: before.version + 1 };
    for (const k of changed) set[k] = patch[k] ?? null;
    this.guardedWrite(before, set);
    const row = this.require(before.id);
    const logId = this.log(actor, 'update', before.id, before, row, approvedBy, undoOf);
    this.emit({ action: 'update', before, after: row, actor, undoOf });
    return { status: 'applied', row, logId };
  }

  protected applyDelete(
    actor: Actor,
    before: Row,
    approvedBy?: string,
    undoOf?: string,
  ): WriteResult {
    const ts = nowIso();
    this.guardedWrite(before, { deletedAt: ts, updatedAt: ts, version: before.version + 1 });
    const after = this.db.select().from(this.table).where(eq(this.cols.id, before.id)).get() as Row;
    const logId = this.log(actor, 'delete', before.id, before, after, approvedBy, undoOf);
    this.emit({ action: 'delete', before, after, actor, undoOf });
    return { status: 'applied', row: after, logId };
  }

  protected applyRestore(actor: Actor, before: Row, undoOf: string): WriteResult {
    try {
      this.guardedWrite(
        before,
        { deletedAt: null, updatedAt: nowIso(), version: before.version + 1 },
        true,
      );
    } catch (err) {
      throw this.mapDbError(err);
    }
    const row = this.require(before.id);
    const logId = this.log(actor, 'update', before.id, before, row, undefined, undoOf);
    this.emit({ action: 'update', before, after: row, actor, undoOf });
    return { status: 'applied', row, logId };
  }

  /** 乐观锁：where 里带 version，更新行数不是 1 就说明被别人抢先改了。 */
  private guardedWrite(before: Row, set: Record<string, unknown>, includeDeleted = false) {
    const cond = includeDeleted
      ? and(eq(this.cols.id, before.id), eq(this.cols.version, before.version))
      : and(
          eq(this.cols.id, before.id),
          eq(this.cols.version, before.version),
          isNull(this.cols.deletedAt),
        );
    let res;
    try {
      res = this.db.update(this.table).set(set).where(cond).run();
    } catch (err) {
      throw this.mapDbError(err);
    }
    if (res.changes !== 1) throw conflict(`${this.name}已被修改，请刷新后重试`);
  }

  protected log(
    actor: Actor,
    action: 'create' | 'update' | 'delete',
    entityId: string,
    before: Row | null,
    after: Row | null,
    approvedBy?: string,
    undoOf?: string,
  ): string {
    const id = newId();
    this.db
      .insert(changeLog)
      .values({
        id,
        entity: this.name,
        entityId,
        action,
        before,
        after,
        actorType: actor.type,
        actorId: actor.userId,
        batchId: actor.batchId ?? null,
        approvedBy: approvedBy ?? null,
        undoOf: undoOf ?? null,
        source: actor.source ?? null,
        createdBy: actor.userId,
        ownerId: actor.userId,
      })
      .run();
    return id;
  }

  protected mapDbError(err: unknown): unknown {
    const code = (err as { code?: string })?.code;
    if (code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return new DomainError('duplicate', `${this.name}已存在（唯一键重复）`);
    }
    return err;
  }
}

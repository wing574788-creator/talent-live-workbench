/**
 * 导入引擎：预演（不写库）→ 提交（一个导入批次，逐行独立事务）→ 整批回滚。
 * 所有写入都走领域服务，所以同样记变更日志、敏感改动进审核队列、可撤销。
 */
import { inArray } from 'drizzle-orm';
import { changeLog } from '../db/schema.ts';
import type { Domain } from '../domain/index.ts';
import { DomainError } from '../domain/errors.ts';
import type { Actor } from '../domain/types.ts';
import { contactHandler } from './handlers/contact.ts';
import { cooperationHandler } from './handlers/cooperation.ts';
import { influencerHandler } from './handlers/influencer.ts';
import { productHandler } from './handlers/product.ts';
import { shipmentHandler } from './handlers/shipment.ts';
import type { ApplyCtx, Handler, PlanCtx } from './handlers/common.ts';
import { Indexes } from './indexes.ts';
import type { ParsedFile } from './parse.ts';
import { RAW_FIELD_KEY, RAW_FIELD_LABEL, buildRecords } from './records.ts';
import { CUSTOM_TARGETS } from './fields.ts';
import type {
  CommitSheetResult,
  Decision,
  Decisions,
  DryRunSheet,
  FieldPolicy,
  PlannedRow,
  RowPlan,
  SheetConfig,
  SheetStats,
  TargetKey,
} from './types.ts';

const HANDLERS: Record<TargetKey, Handler> = {
  influencer: influencerHandler,
  product: productHandler,
  contact: contactHandler,
  cooperation: cooperationHandler,
  shipment: shipmentHandler,
};

/** 一行最终的处理方式：用户指定的优先；新增 → 新建，更新 → 合并，疑似重复必须由用户裁决 */
export function decisionFor(
  plan: Pick<RowPlan, 'status' | 'rowNo'>,
  d: Decisions[string] | undefined,
): Decision | undefined {
  const explicit = d?.rows?.[plan.rowNo];
  if (explicit) return explicit;
  if (plan.status === 'new') return 'new';
  if (plan.status === 'update') return 'merge';
  if (plan.status === 'duplicate') return d?.duplicates;
  return undefined;
}

interface PlannedSheet {
  cfg: SheetConfig;
  plans: RowPlan[];
  view: DryRunSheet;
}

function findSheet(parsed: ParsedFile, name: string) {
  const s = parsed.sheets.find((x) => x.name === name);
  if (!s) throw new DomainError('validation', `文件里没有名为「${name}」的 sheet`);
  return s;
}

function planSheet(
  d: Domain,
  parsed: ParsedFile,
  cfg: SheetConfig,
  decisions: Decisions,
  now: Date,
  ix: Indexes,
): PlannedSheet {
  const sheet = findSheet(parsed, cfg.sheet);
  const built = buildRecords(sheet, cfg, { followStatuses: d.settings.followStatuses(), now });
  const ctx: PlanCtx = { d, ix, seen: new Map(), cfg, now };
  const handler = HANDLERS[cfg.target];
  const configIssues = [...built.configIssues];

  // 自定义字段：已存在但类型对不上的要提前告知
  const defs = d.entity('field_def').findBy('entity', cfg.target);
  for (const c of built.newCustomFields) {
    const have = defs.find((x) => x.key === c.key);
    if (have && have.type !== c.type)
      configIssues.push(`自定义字段「${c.label}」已存在，类型是「${have.type}」，和这次选的不一致`);
  }
  if (!CUSTOM_TARGETS.includes(cfg.target) && built.newCustomFields.length) {
    configIssues.push('寄样不支持新建自定义字段，请改为「存为原始值」或忽略');
  }

  const dec0 = decisions[cfg.sheet];
  const plans: RowPlan[] = [];
  for (const rec of built.records) {
    if (configIssues.length) {
      plans.push({
        rowNo: rec.rowNo,
        status: 'error',
        issues: [{ level: 'error', text: '列映射有问题，请先修正' }],
        summary: '',
        record: rec,
      });
      continue;
    }
    const plan = handler.plan(rec, ctx);
    plans.push(plan);
    // 将要新建的记录立刻以虚拟记录登记：同一张表后面的行能识别重复，后面的表（合作引用达人）能引用到
    if (decisionFor(plan, dec0) === 'new') handler.register?.(plan, ix);
  }

  const stats: SheetStats = {
    total: plans.length,
    new: 0,
    update: 0,
    duplicate: 0,
    error: 0,
    warning: 0,
  };
  for (const p of plans) {
    stats[p.status]++;
    if (p.issues.some((i) => i.level === 'warn')) stats.warning++;
  }
  const dec = decisions[cfg.sheet];
  const rows: PlannedRow[] = plans.map(({ record: _record, ...rest }) => ({
    ...rest,
    decision: decisionFor(rest, dec),
  }));
  const view: DryRunSheet = {
    sheet: cfg.sheet,
    target: cfg.target,
    stats,
    rows,
    enums: built.enums,
    unmappedEnums: built.enums.reduce((n, e) => n + e.values.filter((v) => !v.decided).length, 0),
    undecided: plans.filter((p) => p.status === 'duplicate' && !decisionFor(p, dec)).length,
    newCustomFields: built.newCustomFields,
    configIssues,
  };
  return { cfg, plans, view };
}

/** 预演：逐行标出新增、更新、疑似重复、警告、错误，不写入数据库 */
export function dryRun(
  d: Domain,
  parsed: ParsedFile,
  configs: SheetConfig[],
  decisions: Decisions = {},
  now = new Date(),
) {
  const ix = new Indexes(d);
  const planned: PlannedSheet[] = [];
  for (const cfg of inDependencyOrder(configs)) {
    planned.push(planSheet(d, parsed, cfg, decisions, now, ix));
  }
  return { sheets: planned.map((s) => s.view), planned };
}

/** 商品 → 达人 → 联系人 → 合作 → 寄样：后面的表会引用前面的 */
const ORDER: TargetKey[] = ['product', 'influencer', 'contact', 'cooperation', 'shipment'];
export const inDependencyOrder = (configs: SheetConfig[]) =>
  [...configs].sort((a, b) => ORDER.indexOf(a.target) - ORDER.indexOf(b.target));

function ensureFieldDefs(
  d: Domain,
  actor: Actor,
  cfg: SheetConfig,
  customs: DryRunSheet['newCustomFields'],
  needRaw: boolean,
) {
  if (!CUSTOM_TARGETS.includes(cfg.target)) return;
  const svc = d.entity('field_def');
  const have = new Set(svc.findBy('entity', cfg.target).map((x) => x.key as string));
  const wanted = [
    ...customs,
    ...(needRaw ? [{ key: RAW_FIELD_KEY, label: RAW_FIELD_LABEL, type: 'text' as const }] : []),
  ];
  for (const c of wanted) {
    if (have.has(c.key)) continue;
    svc.create(actor, {
      entity: cfg.target,
      key: c.key,
      label: c.label,
      type: c.type,
      sensitive: false,
      allowOutbound: false,
      indexed: false,
    });
    have.add(c.key);
  }
}

export interface CommitOutcome {
  batchId: string;
  sheets: CommitSheetResult[];
}

/**
 * 提交：先重新预演一遍确认没有未处理的枚举值、未裁决的疑似重复、配置问题；
 * 然后建一个导入批次，每一行在自己的事务里写入（一行失败不影响其他行）。
 */
export function commitImport(
  d: Domain,
  parsed: ParsedFile,
  configs: SheetConfig[],
  decisions: Decisions,
  opts: { fileName: string; templateId?: string | null; now?: Date },
): CommitOutcome {
  const now = opts.now ?? new Date();
  const { planned } = dryRun(d, parsed, configs, decisions, now);
  for (const p of planned) {
    const v = p.view;
    if (v.configIssues.length)
      throw new DomainError('validation', `「${v.sheet}」的列映射有问题：${v.configIssues[0]}`);
    if (v.unmappedEnums)
      throw new DomainError(
        'validation',
        `「${v.sheet}」还有 ${v.unmappedEnums} 个枚举值没有对应的系统选项，处理后才能提交`,
      );
    if (v.undecided)
      throw new DomainError(
        'validation',
        `「${v.sheet}」还有 ${v.undecided} 条疑似重复没有裁决（合并 / 跳过 / 新建）`,
      );
  }

  const user = d.userActor();
  const batch = d.entity('import_batch').create(user, {
    fileName: opts.fileName,
    entity: [...new Set(configs.map((c) => c.target))].join(','),
    templateId: opts.templateId ?? null,
    status: 'running',
  });
  if (batch.status !== 'applied') throw new DomainError('invalid_state', '无法创建导入批次');
  const batchId = batch.row.id;
  const actor: Actor = {
    type: 'import',
    userId: d.userId,
    batchId,
    source: `导入：${opts.fileName}`,
  };

  const results: CommitSheetResult[] = [];
  for (const { cfg, plans, view } of planned) {
    const sheet = findSheet(parsed, cfg.sheet);
    const built = buildRecords(sheet, cfg, { followStatuses: d.settings.followStatuses(), now });
    d.transaction(() => ensureFieldDefs(d, actor, cfg, view.newCustomFields, built.usesRaw));

    const ix = new Indexes(d);
    const policyOf = (field: string): FieldPolicy =>
      cfg.policy?.fields?.[field] ?? cfg.policy?.default ?? 'fill';
    const ctx: ApplyCtx = { d, ix, seen: new Map(), cfg, now, actor, policyOf, groups: new Map() };
    const handler = HANDLERS[cfg.target];
    const res: CommitSheetResult = {
      sheet: cfg.sheet,
      target: cfg.target,
      created: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      pendingReview: 0,
      errors: [],
    };
    for (const plan of plans) {
      const decision = decisionFor(plan, decisions[cfg.sheet]);
      if (plan.status === 'error' || !decision) {
        res.failed++;
        res.errors.push({
          rowNo: plan.rowNo,
          text: plan.issues.find((i) => i.level === 'error')?.text ?? '没有可执行的处理方式',
        });
        continue;
      }
      try {
        const r = d.transaction(() => handler.apply(plan, decision, ctx));
        res.created += r.created;
        res.updated += r.updated;
        res.skipped += r.skipped;
        res.pendingReview += r.pending;
      } catch (err) {
        res.failed++;
        res.errors.push({ rowNo: plan.rowNo, text: (err as Error).message });
      }
    }
    results.push(res);
  }

  d.entity('import_batch').update(user, batchId, {
    status: 'committed',
    stats: { sheets: results },
  });
  return { batchId, sheets: results };
}

export interface RollbackOutcome {
  undone: number;
  rejectedPending: number;
  conflicts: { logId: string; entity: string; target: string }[];
  status: 'rolled_back' | 'partial';
}

/**
 * 整批回滚：逆序撤销这个批次的每一条变更，并驳回批次里还在待审核的改动。
 * 导入之后又被改过的记录标为冲突，保留现状，由用户逐条决定（PRD 6.5）。
 */
export function rollbackBatch(d: Domain, batchId: string): RollbackOutcome {
  const svc = d.entity('import_batch');
  const batch = svc.require(batchId);
  if (batch.status === 'rolled_back')
    throw new DomainError('invalid_state', '这个批次已经回滚过了');
  if (batch.status === 'running') throw new DomainError('invalid_state', '这个批次还没有提交完成');
  const rejected = d.review.rejectBatch(batchId, d.userId);
  const res = d.review.undoBatch(
    d.userActor({ source: `回滚导入批次：${batch.fileName ?? ''}` }),
    batchId,
  );
  const conflicts = res.conflicts.length
    ? d.db
        .select()
        .from(changeLog)
        .where(inArray(changeLog.id, res.conflicts))
        .all()
        .map((l) => ({
          logId: l.id,
          entity: l.entity,
          target: d.reviewView.displayName(l.entity, (l.after ?? l.before) as never),
        }))
    : [];
  const status = conflicts.length ? 'partial' : 'rolled_back';
  svc.update(d.userActor(), batchId, {
    status,
    rolledBackAt: new Date().toISOString(),
    stats: {
      ...((batch.stats as object) ?? {}),
      rollback: {
        undone: res.undone.length,
        conflicts: conflicts.length,
        rejectedPending: rejected.length,
      },
    },
  });
  return { undone: res.undone.length, rejectedPending: rejected.length, conflicts, status };
}

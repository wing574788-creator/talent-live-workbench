import { maskText } from '@workbench/shared';
import type { Domain } from '../../domain/index.ts';
import type { Actor, Row, WriteResult } from '../../domain/types.ts';
import type { Indexes } from '../indexes.ts';
import type {
  Decision,
  FieldChange,
  FieldPolicy,
  ImportRecord,
  RowIssue,
  RowPlan,
  SheetConfig,
} from '../types.ts';

export interface PlanCtx {
  d: Domain;
  ix: Indexes;
  /** 本表内已出现过的键 → 第一次出现的行号（识别文件内重复） */
  seen: Map<string, number>;
  cfg: SheetConfig;
  now: Date;
}

export interface ApplyCtx extends PlanCtx {
  actor: Actor;
  policyOf: (field: string) => FieldPolicy;
  /** 寄样：同一个包裹的分组键 → 已建的寄样单 id */
  groups: Map<string, string>;
}

export interface ApplyResult {
  created: number;
  updated: number;
  pending: number;
  skipped: number;
}

export interface Handler {
  plan(rec: ImportRecord, ctx: PlanCtx): RowPlan;
  apply(plan: RowPlan, decision: Decision, ctx: ApplyCtx): ApplyResult;
  /** 预演时把"将要新建"的记录以虚拟记录登记进索引，让后面的表（如合作引用达人）能对上 */
  register?(plan: RowPlan, ix: Indexes): void;
}

export const noResult = (): ApplyResult => ({ created: 0, updated: 0, pending: 0, skipped: 0 });

export const str = (v: unknown): string => (v == null ? '' : String(v).trim());
export const isBlank = (v: unknown): boolean =>
  v == null || v === '' || (Array.isArray(v) && v.length === 0);
export const hasError = (issues: RowIssue[]) => issues.some((i) => i.level === 'error');
export const asArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : isBlank(v) ? [] : [String(v)];

/** 只保留有值的字段 */
export function pick(values: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (!isBlank(values[k])) out[k] = values[k];
  return out;
}

const MASK_KIND: Record<string, 'name' | 'phone' | 'wechat' | 'address'> = {
  realName: 'name',
  recipient: 'name',
  phone: 'phone',
  wechat: 'wechat',
  address: 'address',
};

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * 合并：按策略决定每个字段怎么处理（PRD 6.1 第 8 步）。
 *   keep 保留旧值 / overwrite 用表里的值覆盖 / fill 只在旧值为空时填入
 * 返回要写入的补丁和用于预览的差异（敏感字段打码）。
 */
export function mergeFields(
  existing: Row,
  incoming: Record<string, unknown>,
  keys: string[],
  policyOf: (field: string) => FieldPolicy,
  labelOf: (field: string) => string,
): { patch: Record<string, unknown>; changes: FieldChange[] } {
  const patch: Record<string, unknown> = {};
  const changes: FieldChange[] = [];
  for (const k of keys) {
    const v = incoming[k];
    if (isBlank(v) || same(existing[k], v)) continue;
    const policy = policyOf(k);
    if (policy === 'keep') continue;
    if (policy === 'fill' && !isBlank(existing[k])) continue;
    patch[k] = v;
    const show = (x: unknown) => (MASK_KIND[k] && !isBlank(x) ? maskText(x, MASK_KIND[k]!) : x);
    changes.push({
      field: k,
      label: labelOf(k),
      before: show(existing[k] ?? null),
      after: show(v),
    });
  }
  return { patch, changes };
}

/** 自定义字段合并（含"导入原始值"）：键用 custom.<key> 取策略 */
export function mergeCustom(
  existing: Row,
  incoming: Record<string, unknown>,
  policyOf: (field: string) => FieldPolicy,
): { custom: Record<string, unknown> | undefined; changes: FieldChange[] } {
  const base = ((existing.custom as Record<string, unknown> | null) ?? {}) as Record<
    string,
    unknown
  >;
  const next = { ...base };
  const changes: FieldChange[] = [];
  for (const [k, v] of Object.entries(incoming)) {
    if (isBlank(v) || same(base[k], v)) continue;
    const policy = policyOf(`custom.${k}`);
    if (policy === 'keep' || (policy === 'fill' && !isBlank(base[k]))) continue;
    next[k] = v;
    changes.push({ field: `custom.${k}`, label: k, before: base[k] ?? null, after: v });
  }
  return { custom: changes.length ? next : undefined, changes };
}

/** 导入原始值：无法解析的单元格合并成一段文字 */
export function rawText(rec: ImportRecord): string | undefined {
  return rec.raws.length ? rec.raws.join('；') : undefined;
}

export function customJson(rec: ImportRecord): Record<string, unknown> | undefined {
  const c: Record<string, unknown> = { ...rec.customs };
  const raw = rawText(rec);
  if (raw) c.import_raw = raw;
  return Object.keys(c).length ? c : undefined;
}

/** 把写入结果记进统计：直接落库算更新，进了审核队列算待审核 */
export function track(res: WriteResult, out: ApplyResult, kind: 'created' | 'updated' = 'updated') {
  if (res.status === 'pending') out.pending++;
  else out[kind]++;
}

export function basePlan(rec: ImportRecord, summary: string, issues: RowIssue[]) {
  return { rowNo: rec.rowNo, summary, issues, record: rec };
}

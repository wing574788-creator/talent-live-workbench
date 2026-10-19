import type { TransformType } from './transforms.ts';

export type TargetKey = 'influencer' | 'product' | 'contact' | 'cooperation' | 'shipment';
export const TARGET_KEYS: TargetKey[] = [
  'influencer',
  'product',
  'contact',
  'cooperation',
  'shipment',
];

export interface FieldDef {
  key: string;
  label: string;
  transform: TransformType;
  required?: boolean;
  /** 枚举字段：固定选项，或 'follow_status'（取设置里的选项） */
  enum?: readonly string[] | 'follow_status';
  /** 导入表里常见的列名写法，用来自动建议映射 */
  aliases: string[];
  sensitive?: boolean;
  hint?: string;
}

export type CustomType = 'text' | 'number' | 'date' | 'bool';

export type ColumnMapping =
  | { kind: 'field'; field: string; transform?: TransformType }
  | { kind: 'custom'; key: string; label: string; type: CustomType }
  | { kind: 'raw' }
  | { kind: 'ignore' };

export type FieldPolicy = 'keep' | 'overwrite' | 'fill';

export interface SheetConfig {
  sheet: string;
  target: TargetKey;
  /** 表头起始行（0 起）和占几行 */
  headerRow: number;
  headerRows: number;
  /** 列序号（字符串）→ 映射 */
  mapping: Record<string, ColumnMapping>;
  /** 字段 → 原值 → 系统选项（null 表示留空） */
  enumMap: Record<string, Record<string, string | null>>;
  /** 合并时：默认策略和按字段覆盖 */
  policy?: { default: FieldPolicy; fields?: Record<string, FieldPolicy> };
}

export type Decision = 'merge' | 'skip' | 'new';

export interface RowIssue {
  level: 'warn' | 'error';
  text: string;
}

/** 一行数据经过映射和转换后的记录 */
export interface ImportRecord {
  rowNo: number;
  values: Record<string, unknown>;
  customs: Record<string, unknown>;
  /** 无法解析的单元格："列名：原值" */
  raws: string[];
  issues: RowIssue[];
}

export type RowStatus = 'new' | 'update' | 'duplicate' | 'error';

export interface FieldChange {
  field: string;
  label: string;
  before: unknown;
  after: unknown;
}

export interface Suspect {
  id: string;
  label: string;
  score: number;
}

export interface RowPlan {
  rowNo: number;
  status: RowStatus;
  issues: RowIssue[];
  /** 用于显示的摘要，如"小美 · 小红书 xm001" */
  summary: string;
  existingId?: string;
  existingLabel?: string;
  suspects?: Suspect[];
  /** 合并时会改动的字段（敏感字段已打码） */
  changes?: FieldChange[];
  /** 寄样：同一个包裹的多行归为一张寄样单 */
  groupKey?: string;
  /** 记录本身，commit 时使用 */
  record: ImportRecord;
}

/** 返回给前端的行：去掉原始记录，加上当前生效的裁决 */
export type PlannedRow = Omit<RowPlan, 'record'> & { decision?: Decision };

/** 每张表的裁决：逐行指定，或对所有疑似重复统一指定 */
export type Decisions = Record<string, { rows?: Record<number, Decision>; duplicates?: Decision }>;

export interface SheetStats {
  total: number;
  new: number;
  update: number;
  duplicate: number;
  error: number;
  warning: number;
}

export interface EnumReport {
  field: string;
  label: string;
  options: string[];
  /** decided = 已有对应选项（自动识别或用户指定，含"留空"）；false 的必须处理后才能继续 */
  values: { raw: string; count: number; mapped: string | null; auto: boolean; decided: boolean }[];
}

export interface DryRunSheet {
  sheet: string;
  target: TargetKey;
  stats: SheetStats;
  rows: PlannedRow[];
  enums: EnumReport[];
  /** 尚未映射的枚举值个数（>0 时不能提交） */
  unmappedEnums: number;
  /** 疑似重复里还没裁决的个数（>0 时不能提交） */
  undecided: number;
  /** 新建自定义字段的预览 */
  newCustomFields: { key: string; label: string; type: CustomType }[];
  /** 配置本身的问题（必填字段没映射、一个字段对应多列等） */
  configIssues: string[];
}

export interface CommitSheetResult {
  sheet: string;
  target: TargetKey;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  /** 敏感改动没有直接写入，进了审核队列 */
  pendingReview: number;
  errors: { rowNo: number; text: string }[];
}

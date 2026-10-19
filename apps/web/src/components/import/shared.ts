/* eslint-disable @typescript-eslint/no-explicit-any */
export type TargetKey = 'influencer' | 'product' | 'contact' | 'cooperation' | 'shipment';
export type Cell = string | number | boolean | null;

export interface FieldMeta {
  key: string;
  label: string;
  transform: string;
  required: boolean;
  sensitive: boolean;
  hint: string | null;
  enum: string[] | null;
}
export interface Meta {
  targets: Record<TargetKey, { label: string; canCustom: boolean; fields: FieldMeta[] }>;
  transforms: Record<string, string>;
}

export type CustomType = 'text' | 'number' | 'date' | 'bool';
export type ColumnMapping =
  | { kind: 'field'; field: string; transform?: string }
  | { kind: 'custom'; key: string; label: string; type: CustomType }
  | { kind: 'raw' }
  | { kind: 'ignore' };

export type FieldPolicy = 'keep' | 'overwrite' | 'fill';
export type Decision = 'merge' | 'skip' | 'new';
export type Decisions = Record<string, { rows?: Record<number, Decision>; duplicates?: Decision }>;

export interface Column {
  index: number;
  name: string;
  samples: Cell[];
  customKey: string;
}

export interface TemplateHit {
  id: string;
  name: string;
  score: number;
  added: string[];
  missing: string[];
  applied: {
    target: TargetKey;
    headerRows: number;
    mapping: Record<string, ColumnMapping>;
    enumMap: Record<string, Record<string, string | null>>;
    policy?: { default: FieldPolicy; fields?: Record<string, FieldPolicy> };
    addedColumns: string[];
  };
}

/** 上传 / 重新分析某张表后后端返回的内容 */
export interface SheetAnalysis {
  name: string;
  rowCount: number;
  mergedCells: number;
  preview: Cell[][];
  header: { row: number; rows: number };
  target: TargetKey;
  targetScores: Record<TargetKey, number>;
  columns: Column[];
  suggestions: { columnIndex: number; mapping: ColumnMapping; confidence: number }[];
  template: TemplateHit | null;
}

/** 向导里每张 sheet 的状态 */
export interface SheetState extends SheetAnalysis {
  include: boolean;
  mapping: Record<string, ColumnMapping>;
  enumMap: Record<string, Record<string, string | null>>;
  policy: { default: FieldPolicy; fields: Record<string, FieldPolicy> };
}

export interface SheetConfig {
  sheet: string;
  target: TargetKey;
  headerRow: number;
  headerRows: number;
  mapping: Record<string, ColumnMapping>;
  enumMap: Record<string, Record<string, string | null>>;
  policy?: { default: FieldPolicy; fields?: Record<string, FieldPolicy> };
}

/** 套用模板，没有模板就用同义词词典的建议（置信度够高的） */
export function initialState(a: SheetAnalysis): SheetState {
  const t = a.template;
  const mapping: Record<string, ColumnMapping> = {};
  if (t) Object.assign(mapping, t.applied.mapping);
  else
    for (const s of a.suggestions)
      if (s.confidence >= 0.7 && s.mapping.kind !== 'ignore')
        mapping[String(s.columnIndex)] = s.mapping;
  return {
    ...a,
    target: t?.applied.target ?? a.target,
    include: a.rowCount > 0,
    mapping,
    enumMap: t?.applied.enumMap ?? {},
    policy: {
      default: t?.applied.policy?.default ?? 'fill',
      fields: t?.applied.policy?.fields ?? {},
    },
  };
}

export function toConfigs(sheets: SheetState[]): SheetConfig[] {
  return sheets
    .filter((s) => s.include)
    .map((s) => ({
      sheet: s.name,
      target: s.target,
      headerRow: s.header.row,
      headerRows: s.header.rows,
      mapping: s.mapping,
      enumMap: s.enumMap,
      policy: { default: s.policy.default, fields: s.policy.fields },
    }));
}

export const cellText = (c: Cell | undefined): string => (c == null ? '' : String(c));

export const POLICY_LABEL: Record<FieldPolicy, string> = {
  fill: '仅填空值',
  overwrite: '用表里的值覆盖',
  keep: '保留旧值',
};
export const DECISION_LABEL: Record<Decision, string> = {
  merge: '合并',
  skip: '跳过',
  new: '新建',
};
export const CUSTOM_TYPE_LABEL: Record<CustomType, string> = {
  text: '文本',
  number: '数字',
  date: '日期',
  bool: '是/否',
};

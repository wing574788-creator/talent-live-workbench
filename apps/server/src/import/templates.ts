/**
 * 映射模板（PRD 6.3）：按"表头文字"保存列映射、值转换和枚举字典，换一份列顺序不同的表也能套用。
 */
import type { Row } from '../domain/types.ts';
import type { Column } from './parse.ts';
import { normHeader, suggestMapping } from './suggest.ts';
import type { ColumnMapping, FieldPolicy, SheetConfig, TargetKey } from './types.ts';

export interface TemplateBody {
  headerRows: number;
  /** 规范化后的表头 → 映射 */
  byHeader: Record<string, ColumnMapping>;
  policy?: { default: FieldPolicy; fields?: Record<string, FieldPolicy> };
}

/** 把一张表当前的配置固化成模板内容 */
export function buildTemplate(cfg: SheetConfig, columns: Column[]) {
  const byHeader: Record<string, ColumnMapping> = {};
  for (const c of columns) {
    const m = cfg.mapping[String(c.index)];
    if (m) byHeader[normHeader(c.name)] = m;
  }
  return {
    entity: cfg.target as string,
    headerSignature: columns.map((c) => c.name),
    mapping: { headerRows: cfg.headerRows, byHeader, policy: cfg.policy } as unknown as Record<
      string,
      unknown
    >,
    transforms: {} as Record<string, unknown>,
    enumMap: cfg.enumMap as unknown as Record<string, unknown>,
  };
}

export interface AppliedTemplate {
  target: TargetKey;
  headerRows: number;
  mapping: Record<string, ColumnMapping>;
  enumMap: SheetConfig['enumMap'];
  policy?: SheetConfig['policy'];
  /** 本次表里新增的列（模板里没有）：已按同义词词典给出建议 */
  addedColumns: string[];
}

/** 把模板套到这张表的列上；模板里没有的新增列用同义词词典给建议 */
export function applyTemplate(tpl: Row, columns: Column[]): AppliedTemplate {
  const body = tpl.mapping as unknown as TemplateBody;
  const target = tpl.entity as TargetKey;
  const mapping: Record<string, ColumnMapping> = {};
  const added: Column[] = [];
  for (const c of columns) {
    const m = body.byHeader?.[normHeader(c.name)];
    if (m) mapping[String(c.index)] = m;
    else added.push(c);
  }
  if (added.length) {
    const used = new Set(
      Object.values(mapping).flatMap((m) => (m.kind === 'field' ? [m.field] : [])),
    );
    for (const s of suggestMapping(target, added)) {
      if (s.mapping.kind === 'ignore') continue; // 没有建议的新增列留空，由用户决定
      if (s.mapping.kind === 'field' && used.has(s.mapping.field)) continue;
      if (s.mapping.kind === 'field') used.add(s.mapping.field);
      mapping[String(s.columnIndex)] = s.mapping;
    }
  }
  return {
    target,
    headerRows: body.headerRows ?? 1,
    mapping,
    enumMap: (tpl.enumMap as SheetConfig['enumMap']) ?? {},
    policy: body.policy,
    addedColumns: added.map((c) => c.name),
  };
}

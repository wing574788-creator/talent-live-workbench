import {
  buildColumns,
  detectHeader,
  type Column,
  type HeaderGuess,
  type ParsedFile,
  type ParsedSheet,
} from './parse.ts';
import { guessTarget, suggestMapping, type Suggestion } from './suggest.ts';
import type { ColumnMapping, SheetConfig, TargetKey } from './types.ts';

export interface SheetAnalysis {
  name: string;
  rowCount: number;
  header: HeaderGuess;
  columns: Column[];
  target: TargetKey;
  targetScores: Record<TargetKey, number>;
  suggestions: Suggestion[];
}

/** 分析一张表：推荐表头行、猜目标实体、按同义词给每一列建议映射 */
export function analyzeSheet(
  sheet: ParsedSheet,
  header?: HeaderGuess,
  target?: TargetKey,
): SheetAnalysis {
  const h = header ?? detectHeader(sheet.rows);
  const { columns, dataStart } = buildColumns(sheet.rows, h);
  const guess = guessTarget(columns);
  const t = target ?? guess.target;
  return {
    name: sheet.name,
    rowCount: Math.max(0, sheet.rows.length - dataStart),
    header: h,
    columns,
    target: t,
    targetScores: guess.scores,
    suggestions: suggestMapping(t, columns),
  };
}

/** 全自动配置：用于测试和一键预览。置信度不够的列默认忽略。 */
export function autoConfig(sheet: ParsedSheet, minConfidence = 0.7): SheetConfig {
  const a = analyzeSheet(sheet);
  const mapping: Record<string, ColumnMapping> = {};
  for (const s of a.suggestions)
    if (s.confidence >= minConfidence) mapping[String(s.columnIndex)] = s.mapping;
  return {
    sheet: sheet.name,
    target: a.target,
    headerRow: a.header.row,
    headerRows: a.header.rows,
    mapping,
    enumMap: {},
  };
}

export const autoConfigs = (parsed: ParsedFile) =>
  parsed.sheets.filter((s) => s.rows.length > 1).map((s) => autoConfig(s));

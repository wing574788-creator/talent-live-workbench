/**
 * 导入映射建议（PRD 6.4 / 7.1 第 5 条）：规则（同义词）先给出建议，规则拿不准的列再请模型补充。
 * 发给模型的只有表头和每列最多 3 个样本值（过外发过滤器），不发整张表。
 * 没有模型、被外发设置拒绝或模型出错时，仍然返回规则建议。
 */
import { z } from 'zod';
import { TARGET_FIELDS } from '../import/fields.ts';
import type { Column } from '../import/parse.ts';
import { suggestMapping } from '../import/suggest.ts';
import { TARGET_KEYS, type ColumnMapping, type TargetKey } from '../import/types.ts';
import { DomainError } from '../domain/errors.ts';
import type { AiContext } from './index.ts';

const SYSTEM = [
  '你帮用户把 Excel 的列对应到系统字段。只输出一个 JSON 数组，不要任何解释，不要代码块标记。',
  '每个元素：{"columnIndex": 列序号, "field": 字段键或 null, "confidence": 0 到 1}。',
  '规则：field 只能取"可选字段"里的键；列的含义不确定或没有对应字段就填 null；一个字段最多对应一列；根据表头和样本值一起判断。',
].join('\n');

const answerSchema = z.array(
  z.object({
    columnIndex: z.number().int(),
    field: z.string().nullable(),
    confidence: z.number().min(0).max(1).optional(),
  }),
);

export interface MappingSuggestion {
  columnIndex: number;
  mapping: ColumnMapping;
  confidence: number;
  source: 'rules' | 'ai';
}

export interface MappingResult {
  suggestions: MappingSuggestion[];
  /** ai = 规则 + 模型补充；rules = 只有规则 */
  source: 'ai' | 'rules';
  /** 没用上模型时的原因，界面上提示用户 */
  message?: string;
}

const LOW = 0.7;
const short = (v: unknown) =>
  String(v ?? '')
    .trim()
    .slice(0, 30);

export async function suggestMappingWithAi(
  ai: AiContext,
  input: { target: TargetKey; columns: Column[] },
): Promise<MappingResult> {
  if (!TARGET_KEYS.includes(input.target)) throw new DomainError('validation', '未知的导入目标');
  const rules = suggestMapping(input.target, input.columns).map<MappingSuggestion>((s) => ({
    ...s,
    source: 'rules',
  }));
  const doubtful = rules.filter((s) => s.confidence < LOW);
  if (!doubtful.length)
    return {
      suggestions: rules,
      source: 'rules',
      message: '所有列都已按表头对上，不需要 AI 补充。',
    };

  const fields = TARGET_FIELDS[input.target];
  const taken = new Set(
    rules
      .filter((s) => s.confidence >= LOW && s.mapping.kind === 'field')
      .map((s) => (s.mapping as { field: string }).field),
  );
  const available = fields.filter((f) => !taken.has(f.key));
  const payload = {
    可选字段: available.map((f) => ({
      key: f.key,
      名称: f.label,
      说明: f.hint ?? undefined,
      常见写法: f.aliases.slice(0, 6),
    })),
    待判断的列: doubtful.map((s) => {
      const col = input.columns.find((c) => c.index === s.columnIndex)!;
      return { columnIndex: col.index, 表头: col.name, 样本值: col.samples.slice(0, 3).map(short) };
    }),
  };

  let reply: string;
  try {
    reply = await ai.service.complete('mapping', SYSTEM, JSON.stringify(payload));
  } catch (err) {
    const e = err as DomainError;
    if (
      e.code === 'ai_not_configured' ||
      e.code === 'outbound_blocked' ||
      e.code === 'validation'
    ) {
      return { suggestions: rules, source: 'rules', message: `${e.message}（已使用规则建议）` };
    }
    throw err;
  }

  let parsed: z.infer<typeof answerSchema>;
  try {
    const start = reply.indexOf('[');
    const end = reply.lastIndexOf(']');
    parsed = answerSchema.parse(JSON.parse(reply.slice(start, end + 1)));
  } catch {
    return { suggestions: rules, source: 'rules', message: 'AI 的回答格式不对，已使用规则建议。' };
  }

  const validKeys = new Set(available.map((f) => f.key));
  const doubtfulCols = new Set(doubtful.map((s) => s.columnIndex));
  const usedByAi = new Set<string>();
  const byCol = new Map<number, MappingSuggestion>();
  for (const a of [...parsed].sort((x, y) => (y.confidence ?? 0.5) - (x.confidence ?? 0.5))) {
    if (
      !a.field ||
      !doubtfulCols.has(a.columnIndex) ||
      !validKeys.has(a.field) ||
      usedByAi.has(a.field)
    )
      continue;
    usedByAi.add(a.field);
    byCol.set(a.columnIndex, {
      columnIndex: a.columnIndex,
      mapping: { kind: 'field', field: a.field },
      // AI 的建议置信度上限 0.85，界面上仍需要用户看一眼
      confidence: Math.round(Math.min(Math.max(a.confidence ?? 0.5, 0.3), 0.85) * 100) / 100,
      source: 'ai',
    });
  }
  return { suggestions: rules.map((s) => byCol.get(s.columnIndex) ?? s), source: 'ai' };
}

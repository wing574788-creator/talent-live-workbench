/**
 * 列映射建议：用同义词词典把"表头文字"对到系统字段，并给出置信度。
 * AI 只做这件事的增强（阶段 7）；没有模型或关闭外发时就用这里的规则（PRD 6.4）。
 */
import { ENUM_SYNONYMS, TARGET_FIELDS } from './fields.ts';
import type { Column } from './parse.ts';
import { toText } from './transforms.ts';
import { TARGET_KEYS, type ColumnMapping, type FieldDef, type TargetKey } from './types.ts';

/** 表头归一：小写，去空白、标点、括号里的说明（如"（必填）"） */
export function normHeader(s: string): string {
  return s
    .toLowerCase()
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s_\-:：*＊/\\·.]+/g, '');
}

function score(header: string, field: FieldDef): number {
  // 两行表头合成的"分组/列名"，具体列名在最后一段，两种写法都试，取高的
  const last = header.includes('/') ? header.slice(header.lastIndexOf('/') + 1) : null;
  const full = scoreOne(header, field);
  return last ? Math.max(full, scoreOne(last, field)) : full;
}

function scoreOne(header: string, field: FieldDef): number {
  const h = normHeader(header);
  if (!h) return 0;
  const names = [field.label, ...field.aliases].map(normHeader);
  if (names.includes(h)) return 1;
  // "达人昵称（必填）"之类：包含关系，要求较短的一方至少 2 个字
  let best = 0;
  for (const n of names) {
    if (Math.min(n.length, h.length) >= 2 && (h.includes(n) || n.includes(h))) {
      best = Math.max(
        best,
        0.7 * (Math.min(n.length, h.length) / Math.max(n.length, h.length)) + 0.3,
      );
    }
  }
  return best >= 0.55 ? best : 0;
}

export interface Suggestion {
  columnIndex: number;
  mapping: ColumnMapping;
  /** 0–1；1 表示表头和字段名（或同义词）完全一致 */
  confidence: number;
}

/** 贪心：先给置信度最高的列分配字段，每个字段只用一次 */
export function suggestMapping(target: TargetKey, columns: Column[]): Suggestion[] {
  const fields = TARGET_FIELDS[target];
  const pairs: { col: number; field: FieldDef; s: number }[] = [];
  for (const c of columns)
    for (const fd of fields) {
      const s = score(c.name, fd);
      if (s > 0) pairs.push({ col: c.index, field: fd, s });
    }
  pairs.sort((a, b) => b.s - a.s);
  const usedCols = new Set<number>();
  const usedFields = new Set<string>();
  const out = new Map<number, Suggestion>();
  for (const p of pairs) {
    if (usedCols.has(p.col) || usedFields.has(p.field.key)) continue;
    usedCols.add(p.col);
    usedFields.add(p.field.key);
    out.set(p.col, {
      columnIndex: p.col,
      mapping: { kind: 'field', field: p.field.key },
      confidence: Math.round(p.s * 100) / 100,
    });
  }
  return columns.map(
    (c) => out.get(c.index) ?? { columnIndex: c.index, mapping: { kind: 'ignore' }, confidence: 0 },
  );
}

/** 根据表头猜这张表是什么：每个目标的匹配程度，取最高的 */
export function guessTarget(columns: Column[]): {
  target: TargetKey;
  scores: Record<TargetKey, number>;
} {
  const scores = {} as Record<TargetKey, number>;
  for (const t of TARGET_KEYS) {
    const sug = suggestMapping(t, columns).filter((s) => s.confidence > 0);
    const required = TARGET_FIELDS[t].filter((f) => f.required);
    const hit = new Set(sug.map((s) => (s.mapping.kind === 'field' ? s.mapping.field : '')));
    const reqHit = required.filter((r) => hit.has(r.key)).length / Math.max(1, required.length);
    const total = sug.reduce((n, s) => n + s.confidence, 0);
    // 必填字段命中得分高，匹配的列越多越好
    scores[t] = Math.round((total + reqHit * 2) * 100) / 100;
  }
  const target = (Object.entries(scores).sort((a, b) => b[1] - a[1])[0]?.[0] ??
    'influencer') as TargetKey;
  return { target, scores };
}

// ───────────── 枚举值映射 ─────────────
const nv = (s: string) => s.toLowerCase().replace(/\s+/g, '');

/** 把表里的值对到系统选项：先看是否就是某个选项，再看同义词词典。对不上返回 null。 */
export function resolveEnum(
  fieldKey: string,
  options: readonly string[],
  raw: unknown,
): string | null {
  const v = nv(toText(raw));
  if (!v) return null;
  for (const o of options) if (nv(o) === v) return o;
  const dict = ENUM_SYNONYMS[fieldKey];
  if (dict) {
    for (const [option, syns] of Object.entries(dict)) {
      if (options.includes(option) && syns.some((s) => nv(s) === v)) return option;
    }
  }
  return null;
}

// ───────────── 模板匹配（按表头特征） ─────────────
export interface TemplateLike {
  id: string;
  name: string;
  entity: string;
  headerSignature: string[];
}

/** 表头集合的相似度（Jaccard）：一样的列越多越像 */
export function signatureSimilarity(a: string[], b: string[]): number {
  const A = new Set(a.map(normHeader).filter(Boolean));
  const B = new Set(b.map(normHeader).filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

export function bestTemplate<T extends TemplateLike>(
  templates: T[],
  headers: string[],
  minScore = 0.6,
) {
  let best: { template: T; score: number } | null = null;
  for (const t of templates) {
    const score = signatureSimilarity(t.headerSignature, headers);
    if (score >= minScore && (!best || score > best.score)) best = { template: t, score };
  }
  if (!best) return null;
  const have = new Set(best.template.headerSignature.map(normHeader));
  const now = new Set(headers.map(normHeader));
  return {
    ...best,
    /** 本次表里新增的列（模板里没有） */
    added: headers.filter((h) => !have.has(normHeader(h))),
    /** 模板里有、这次表里没有的列 */
    missing: best.template.headerSignature.filter((h) => !now.has(normHeader(h))),
  };
}

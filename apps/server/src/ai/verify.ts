/**
 * 金额与佣金护栏（PRD 7.3）：必须带类型和单位；数值和原文逐字核对，对不上拒绝写入；
 * 佣金超过 50% 或明显偏离该达人历史值时给出警告（卡片标黄）。
 */
import { DomainError } from '../domain/errors.ts';
import { parseMoneyCents, parsePercent } from '../import/transforms.ts';

const FULL = '０１２３４５６７８９．％，：';
const HALF = '0123456789.%,:';

/** 全角转半角、去空白，方便做"原文里有没有这句话"的比较 */
export function normText(s: string): string {
  return [...s]
    .map((c) => {
      const i = FULL.indexOf(c);
      return i >= 0 ? HALF[i]! : c;
    })
    .join('')
    .replace(/\s+/g, '')
    .toLowerCase();
}

const CN: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};
function cnNumber(s: string): number | null {
  const m = s.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/);
  if (m) return (m[1] ? CN[m[1]]! : 1) * 10 + (m[2] ? CN[m[2]]! : 0);
  return s.length === 1 && s in CN ? CN[s]! : null;
}

function assertQuoteInOriginal(quote: string, original: string) {
  const q = normText(quote);
  if (q.length < 2)
    throw new DomainError('validation', '缺少原文出处：请引用用户原话里写到这个数字的那一小段。');
  if (!normText(original).includes(q)) {
    throw new DomainError(
      'validation',
      `引用的出处「${quote}」不在用户的原文里。数字必须来自原文，不能自己推算或编造；请逐字引用原话。`,
    );
  }
}

/** 佣金：原文里必须是"25个点""25%"这类带单位的写法 */
export function verifyCommission(value: number, quote: string, original: string) {
  assertQuoteInOriginal(quote, original);
  if (!Number.isFinite(value) || value <= 0 || value > 100)
    throw new DomainError('validation', `佣金应在 0 到 100 之间（当前 ${value}）。`);
  const q = normText(quote);
  const found: number[] = [];
  for (const m of q.matchAll(/(\d+(?:\.\d+)?)(?:个百分点|个点|百分点|点|%)/g)) {
    const r = parsePercent(`${m[1]}%`);
    if (r.ok) found.push(r.value);
  }
  for (const m of q.matchAll(/([一二两三四五六七八九十]+)(?:个百分点|个点|百分点|点)/g)) {
    const n = cnNumber(m[1]!);
    if (n !== null) found.push(n);
  }
  if (!found.length)
    throw new DomainError(
      'validation',
      `佣金必须带单位：原文「${quote}」里没有"个点"或"%"，无法确认这是佣金比例。请向用户确认。`,
    );
  if (!found.some((f) => Math.abs(f - value) < 1e-6)) {
    throw new DomainError(
      'validation',
      `数值和原文对不上：原文是「${quote}」（${found.join('、')}%），但要写入的是 ${value}%，已拒绝。`,
    );
  }
}

/** 金额：必须带 ¥ / 元 / 万 / w / k 之类的单位，换算成"分"后和原文逐字核对 */
export function verifyMoneyCents(cents: number, quote: string, original: string) {
  assertQuoteInOriginal(quote, original);
  if (!Number.isInteger(cents) || cents < 0)
    throw new DomainError('validation', '金额必须是不小于 0 的整数"分"。');
  const q = normText(quote);
  const found: number[] = [];
  for (const m of q.matchAll(/(?:¥|￥)?(\d[\d,]*(?:\.\d+)?)(万|w|k|千|元|块)?/g)) {
    const hasUnit = !!m[2] || m[0].startsWith('¥') || m[0].startsWith('￥');
    if (!hasUnit) continue;
    const r = parseMoneyCents(m[0]);
    if (r.ok) found.push(r.value);
  }
  if (!found.length)
    throw new DomainError(
      'validation',
      `金额必须带单位：原文「${quote}」里没有"元""万""w""k"或 ¥，无法确认金额。请向用户确认。`,
    );
  if (!found.includes(cents)) {
    throw new DomainError(
      'validation',
      `数值和原文对不上：原文是「${quote}」（${found.map((c) => c / 100).join('、')} 元），但要写入的是 ${cents / 100} 元，已拒绝。`,
    );
  }
}

/** 异常佣金警告：超过 50%，或明显偏离该达人历史值（相差 10 个点以上，或高于 1.5 倍 / 低于一半） */
export function commissionWarnings(pct: number, history: number[]): string[] {
  const out: string[] = [];
  if (pct > 50) out.push(`佣金 ${pct}% 超过 50%，请再核对`);
  const h = history.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (h.length) {
    const mid =
      h.length % 2 ? h[(h.length - 1) / 2]! : (h[h.length / 2 - 1]! + h[h.length / 2]!) / 2;
    if (Math.abs(pct - mid) >= 10 || pct >= mid * 1.5 || pct <= mid * 0.5)
      out.push(`明显偏离该达人历史佣金（历史约 ${Math.round(mid * 10) / 10}%）`);
  }
  return [...new Set(out)];
}

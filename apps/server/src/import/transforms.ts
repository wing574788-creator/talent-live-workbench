/**
 * 导入值转换器（PRD 6.2）。每个转换器都是纯函数：
 *   输入单元格原始值（字符串 / 数字 / Date / 布尔），输出 { ok:true, value, warning? } 或 { ok:false, error }。
 * 无法解析时由调用方把原值存进"导入原始值"并标黄提示，不丢数据。
 */
import { PLATFORMS } from '@workbench/shared';

export type Parsed<T> = { ok: true; value: T; warning?: string } | { ok: false; error: string };

export const isEmpty = (v: unknown): boolean =>
  v == null || (typeof v === 'string' && v.trim() === '');

const ok = <T>(value: T, warning?: string): Parsed<T> => ({ ok: true, value, warning });
const fail = (error: string): Parsed<never> => ({ ok: false, error });

export const toText = (v: unknown): string => {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') return Number.isInteger(v) ? v.toFixed(0) : String(v);
  return String(v ?? '').trim();
};

// ───────────── 日期 ─────────────
const pad = (n: number) => String(n).padStart(2, '0');

function validYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= last;
}

/** Excel 日期序列号（1900 系统）→ YYYY-MM-DD。25569 = 1970-01-01，已处理 1900 年闰年 bug。 */
export function excelSerialToDate(serial: number): string {
  const ms = Math.round((serial - 25569) * 86400_000);
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * 支持：Excel 序列号、Date 对象、2026/3/1、2026-03-01、2026.3.1、2026年3月1日、20260301、
 * 3月1日 / 3/1（缺年份：按 now 的年份补全并给出提示）。
 */
export function parseDate(raw: unknown, now: Date = new Date()): Parsed<string> {
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return fail('日期无效');
    // SheetJS 的 Date 以本地零点表示 Excel 日期，按本地年月日取值最准
    return ok(`${raw.getFullYear()}-${pad(raw.getMonth() + 1)}-${pad(raw.getDate())}`);
  }
  if (typeof raw === 'number') {
    if (raw >= 20000 && raw <= 80000) return ok(excelSerialToDate(raw));
    if (Number.isInteger(raw) && raw >= 19000101 && raw <= 20991231)
      return parseDate(String(raw), now);
    return fail(`无法识别的日期数字：${raw}`);
  }
  const s = toText(raw).replace(/\s+/g, ' ');
  if (!s) return fail('日期为空');
  if (/^\d{5}(\.\d+)?$/.test(s)) return parseDate(Number(s), now);

  const full = s.match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?(?:[ T].*)?$/);
  const compact = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  const m = full ?? compact;
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return validYmd(y, mo, d) ? ok(`${y}-${pad(mo)}-${pad(d)}`) : fail(`不存在的日期：${s}`);
  }
  const noYear = s.match(/^(\d{1,2})\s*[月/.-]\s*(\d{1,2})\s*日?$/);
  if (noYear) {
    const year = new Date(now.getTime() + 8 * 3600_000).getUTCFullYear();
    const [mo, d] = [Number(noYear[1]), Number(noYear[2])];
    return validYmd(year, mo, d)
      ? ok(`${year}-${pad(mo)}-${pad(d)}`, `缺少年份，已按 ${year} 年处理`)
      : fail(`不存在的日期：${s}`);
  }
  return fail(`无法识别的日期：${s}`);
}

// ───────────── 数量（金额 / 粉丝数共用） ─────────────
const UNITS: Record<string, number> = {
  k: 1_000,
  K: 1_000,
  千: 1_000,
  w: 10_000,
  W: 10_000,
  万: 10_000,
  亿: 100_000_000,
};

/** "12.3w" "1.2万" "3k" "1,234" "¥1,299.00" "1299元" → 数值（未乘小数位） */
function parseScaled(raw: unknown): Parsed<number> {
  if (typeof raw === 'number') return Number.isFinite(raw) ? ok(raw) : fail('不是有效数字');
  const s = toText(raw)
    .replace(/[¥￥$\s,，]/g, '')
    .replace(/元|块|人民币|RMB|rmb|粉丝|粉|人/g, '');
  if (!s) return fail('为空');
  const m = s.match(/^(-?\d+(?:\.\d+)?)([kKwW千万亿])?$/);
  if (!m) return fail(`无法识别的数值：${toText(raw)}`);
  const unit = m[2] ? UNITS[m[2]]! : 1;
  // 先乘单位再取整，避免 12.3 * 10000 的浮点误差
  return ok(Math.round(Number(m[1]) * unit * 1e6) / 1e6);
}

/** 金额 → 整数"分"（铁律 6）。支持 ¥、千分位、"1.2万"、"3k"；负数拒绝。 */
export function parseMoneyCents(raw: unknown): Parsed<number> {
  const r = parseScaled(raw);
  if (!r.ok) return fail(`无法识别的金额：${toText(raw)}`);
  if (r.value < 0) return fail('金额不能为负数');
  return ok(Math.round(r.value * 100));
}

/** 粉丝数 → 整数。"12.3w" → 123000。 */
export function parseFollowers(raw: unknown): Parsed<number> {
  const r = parseScaled(raw);
  if (!r.ok) return fail(`无法识别的粉丝数：${toText(raw)}`);
  if (r.value < 0) return fail('粉丝数不能为负数');
  return ok(Math.round(r.value));
}

export function parseInteger(raw: unknown): Parsed<number> {
  const r = parseScaled(raw);
  if (!r.ok || !Number.isInteger(r.value)) return fail(`不是整数：${toText(raw)}`);
  return ok(r.value);
}

// ───────────── 百分比 ─────────────
/** "20%" "20个点" "20 个点" "0.2" 0.25 → 百分比数值（20、25）。0–100 以外拒绝。 */
export function parsePercent(raw: unknown): Parsed<number> {
  let n: number;
  if (typeof raw === 'number') {
    n = raw > 0 && raw < 1 ? raw * 100 : raw;
  } else {
    const s = toText(raw).replace(/\s+/g, '');
    const m = s.match(/^(\d+(?:\.\d+)?)(%|％|个点|点|个百分点)?$/);
    if (!m) return fail(`无法识别的百分比：${toText(raw)}`);
    n = Number(m[1]);
    if (!m[2] && n > 0 && n < 1) n = n * 100; // "0.2" 视为 20%
  }
  n = Math.round(n * 1e6) / 1e6;
  if (n < 0 || n > 100) return fail(`百分比应在 0–100 之间：${toText(raw)}`);
  return ok(n);
}

// ───────────── 平台 / 多值 / 布尔 ─────────────
const PLATFORM_ALIASES: Record<string, (typeof PLATFORMS)[number]> = {
  小红书: '小红书',
  红书: '小红书',
  xhs: '小红书',
  xiaohongshu: '小红书',
  rednote: '小红书',
  red: '小红书',
  抖音: '抖音',
  dy: '抖音',
  douyin: '抖音',
  视频号: '视频号',
  微信视频号: '视频号',
  wxsph: '视频号',
  wechatchannels: '视频号',
};

export function normalizePlatform(raw: unknown): Parsed<string> {
  const s = toText(raw).replace(/\s+/g, '').toLowerCase();
  const hit = PLATFORM_ALIASES[s];
  return hit ? ok(hit) : fail(`无法识别的平台：${toText(raw)}`);
}

/** "小红书/抖音" "A、B，C" → 去重后的数组 */
export function splitMulti(raw: unknown, separators = /[/、,，;；|\n]+/): string[] {
  return [
    ...new Set(
      toText(raw)
        .split(separators)
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  ];
}

export function parseBool(raw: unknown): Parsed<boolean> {
  if (typeof raw === 'boolean') return ok(raw);
  const s = toText(raw).toLowerCase();
  if (['是', 'y', 'yes', 'true', '1', '✓', '√'].includes(s)) return ok(true);
  if (['否', 'n', 'no', 'false', '0', '✗', '×'].includes(s)) return ok(false);
  return fail(`不是是/否：${toText(raw)}`);
}

/** 手机号：去掉空格和短横线；纯数字存字符串，不丢前导 0 */
export function parsePhone(raw: unknown): Parsed<string> {
  const s = toText(raw).replace(/[\s-]/g, '');
  return s ? ok(s) : fail('为空');
}

// ───────────── 列转换类型 ─────────────
export const TRANSFORM_TYPES = [
  'text',
  'integer',
  'date',
  'money',
  'followers',
  'percent',
  'platform',
  'multi',
  'bool',
] as const;
export type TransformType = (typeof TRANSFORM_TYPES)[number];

export const TRANSFORM_LABELS: Record<TransformType, string> = {
  text: '文本',
  integer: '整数',
  date: '日期',
  money: '金额（存为分）',
  followers: '粉丝数',
  percent: '百分比',
  platform: '平台归一',
  multi: '多值（拆分）',
  bool: '是/否',
};

/** 按类型转换一个单元格。空单元格由调用方先处理。 */
export function applyTransform(type: TransformType, raw: unknown, now?: Date): Parsed<unknown> {
  switch (type) {
    case 'date':
      return parseDate(raw, now);
    case 'money':
      return parseMoneyCents(raw);
    case 'followers':
      return parseFollowers(raw);
    case 'integer':
      return parseInteger(raw);
    case 'percent':
      return parsePercent(raw);
    case 'platform':
      return normalizePlatform(raw);
    case 'bool':
      return parseBool(raw);
    case 'multi':
      return ok(splitMulti(raw));
    default:
      return ok(toText(raw));
  }
}

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

export function fmtMoney(cents: number | null | undefined): string {
  if (cents == null) return '';
  return (
    '¥' +
    (cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  );
}

/** "10月18日 周日"：日期一律回显为绝对日期加星期（铁律 7）。 */
export function fmtDate(d: string | null | undefined): string {
  if (!d) return '';
  const dt = new Date(d.length === 10 ? `${d}T00:00:00+08:00` : d);
  if (Number.isNaN(dt.getTime())) return d;
  const sh = new Date(dt.getTime() + 8 * 3600_000); // 按 Asia/Shanghai 取年月日
  return `${sh.getUTCMonth() + 1}月${sh.getUTCDate()}日 周${WEEK[sh.getUTCDay()]}`;
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const sh = new Date(new Date(iso).getTime() + 8 * 3600_000);
  const hh = String(sh.getUTCHours()).padStart(2, '0');
  const mm = String(sh.getUTCMinutes()).padStart(2, '0');
  return `${fmtDate(iso)} ${hh}:${mm}`;
}

export function yuanToCents(s: string): number | null {
  const t = s.trim().replace(/[¥,，]/g, '');
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return NaN;
  return Math.round(n * 100);
}

/** 北京时间的今天 YYYY-MM-DD */
export function todayStr(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}

/**
 * 相对日期由程序解析（CLAUDE.md 铁律 7）：模型不负责计算"下周三""月底"，只负责把原文里的日期说法
 * 交给 resolve_date；写入类工具会用同一个解析器复核，对不上就拒绝。所有日期按北京时间（Asia/Shanghai）。
 */
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const DAY_MS = 86400_000;

export interface ResolvedDate {
  date: string;
  weekday: string;
  /** 界面回显："10月21日 周三" */
  display: string;
}

/** 以北京时间的"今天零点"为基准，用 UTC 日历做加减，避免夏令时和本机时区的干扰 */
export class ShDate {
  constructor(readonly utcMs: number) {}
  static today(now: Date = new Date()) {
    const sh = new Date(now.getTime() + 8 * 3600_000);
    return new ShDate(Date.UTC(sh.getUTCFullYear(), sh.getUTCMonth(), sh.getUTCDate()));
  }
  static ymd(y: number, m: number, d: number) {
    return new ShDate(Date.UTC(y, m - 1, d));
  }
  get y() {
    return new Date(this.utcMs).getUTCFullYear();
  }
  get m() {
    return new Date(this.utcMs).getUTCMonth() + 1;
  }
  get d() {
    return new Date(this.utcMs).getUTCDate();
  }
  get dow() {
    return new Date(this.utcMs).getUTCDay();
  }
  plus(days: number) {
    return new ShDate(this.utcMs + days * DAY_MS);
  }
  /** 当月最后一天 */
  endOfMonth() {
    return ShDate.ymd(this.y, this.m + 1, 0);
  }
  iso() {
    return new Date(this.utcMs).toISOString().slice(0, 10);
  }
  /** 周一为一周的第一天，返回本周一 */
  monday() {
    return this.plus(-((this.dow + 6) % 7));
  }
}

const out = (d: ShDate): ResolvedDate => ({
  date: d.iso(),
  weekday: `周${WEEK[d.dow]}`,
  display: `${d.m}月${d.d}日 周${WEEK[d.dow]}`,
});

const CN_NUM: Record<string, number> = {
  零: 0,
  〇: 0,
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
  十: 10,
};
/** "三" "十二" "二十五" "12" → 数字 */
function num(s: string): number | null {
  if (/^\d+$/.test(s)) return Number(s);
  if (s === '十') return 10;
  const m = s.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/);
  if (m) return (m[1] ? CN_NUM[m[1]]! : 1) * 10 + (m[2] ? CN_NUM[m[2]]! : 0);
  if (s.length === 1 && s in CN_NUM) return CN_NUM[s]!;
  return null;
}

const WEEKDAY_IDX: Record<string, number> = {
  日: 0,
  天: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
};

const validDay = (y: number, m: number, d: number) =>
  m >= 1 && m <= 12 && d >= 1 && d <= ShDate.ymd(y, m + 1, 0).d;

/**
 * 解析一个日期说法。解析不了返回 null（调用方要让用户补充，不能让模型猜）。
 * prefer：没写年份的"M月D日"，future = 过了就取明年，nearest = 取离今天最近的那年，past = 取今年
 */
export function resolveDate(
  text: string,
  now: Date = new Date(),
  prefer: 'future' | 'nearest' | 'past' = 'future',
): ResolvedDate | null {
  const s = text
    .replace(/\s+/g, '')
    .replace(/[，,。]/g, '')
    .replace(/（.*?）|\(.*?\)/g, '')
    // "明天晚上8点" → "明天"：具体钟点不属于日期，开播时段另有字段
    .replace(
      /(早上|上午|中午|下午|晚上|晚间|夜里|凌晨|早|晚)[\d一二三四五六七八九十两:：点半]*$/,
      '',
    );
  const today = ShDate.today(now);
  let m: RegExpMatchArray | null;

  // 完整日期
  if ((m = s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})[日号]?$/))) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return validDay(y, mo, d) ? out(ShDate.ymd(y, mo, d)) : null;
  }
  // 今天明天
  const REL: Record<string, number> = {
    今天: 0,
    今日: 0,
    明天: 1,
    明日: 1,
    后天: 2,
    大后天: 3,
    昨天: -1,
    昨日: -1,
    前天: -2,
  };
  if (s in REL) return out(today.plus(REL[s]!));
  // N天后 / N天前 / N周后
  if (
    (m = s.match(
      /^([\d一二两三四五六七八九十]+)(天|日|周|个星期|星期)(后|以后|之后|前|以前|之前)$/,
    ))
  ) {
    const n = num(m[1]!);
    if (n === null) return null;
    const per = m[2] === '天' || m[2] === '日' ? 1 : 7;
    return out(today.plus((/前/.test(m[3]!) ? -1 : 1) * n * per));
  }
  // 周X / 本周X / 下周X / 下下周X / 上周X
  if ((m = s.match(/^(下下|下个?|上个?|本|这个?)?(?:周|星期|礼拜)([日天一二三四五六])$/))) {
    const idx = WEEKDAY_IDX[m[2]!]!;
    const prefix = m[1] ?? '';
    const mon = today.monday();
    const inWeek = (offsetWeeks: number) => mon.plus(offsetWeeks * 7 + ((idx + 6) % 7));
    if (prefix.startsWith('下下')) return out(inWeek(2));
    if (prefix.startsWith('下')) return out(inWeek(1));
    if (prefix.startsWith('上')) return out(inWeek(-1));
    if (prefix === '本' || prefix.startsWith('这')) return out(inWeek(0));
    // 单说"周三"：今天或之后最近的一个
    const diff = (idx - today.dow + 7) % 7;
    return out(today.plus(diff));
  }
  // 周末 = 今天或之后最近的周六（周日说"周末"指的是下一个）
  const nextSaturday = today.plus((6 - today.dow + 7) % 7);
  if (s === '周末' || s === '本周末' || s === '这周末') return out(nextSaturday);
  if (s === '下周末') return out(nextSaturday.plus(7));
  // 月底 / 月初
  if (/^(本月底|月底|本月末|月末|这个月底)$/.test(s)) return out(today.endOfMonth());
  if (/^(下月底|下个月底|下月末|下个月末)$/.test(s))
    return out(ShDate.ymd(today.y, today.m + 1, 1).endOfMonth());
  if (/^(月初|本月初)$/.test(s)) return out(ShDate.ymd(today.y, today.m, 1));
  if (/^(下月初|下个月初)$/.test(s)) return out(ShDate.ymd(today.y, today.m + 1, 1));
  // 下个月N号 / 本月N号
  if ((m = s.match(/^(下个?月|本月|这个月)([\d一二三四五六七八九十]+)[日号]$/))) {
    const d = num(m[2]!);
    const base = m[1]!.startsWith('下') ? ShDate.ymd(today.y, today.m + 1, 1) : today;
    return d !== null && validDay(base.y, base.m, d) ? out(ShDate.ymd(base.y, base.m, d)) : null;
  }
  // M月D日 / M/D / M-D / M.D
  if ((m = s.match(/^([\d一二三四五六七八九十]+)[月/.-]([\d一二三四五六七八九十]+)[日号]?$/))) {
    const [mo, d] = [num(m[1]!), num(m[2]!)];
    if (mo === null || d === null || !validDay(today.y, mo, d)) return null;
    let y = today.y;
    const thisYear = ShDate.ymd(y, mo, d);
    if (prefer === 'future' && thisYear.utcMs < today.utcMs) y += 1;
    else if (prefer === 'nearest') {
      const next = ShDate.ymd(y + 1, mo, d);
      if (thisYear.utcMs < today.utcMs && next.utcMs - today.utcMs < today.utcMs - thisYear.utcMs)
        y += 1;
    }
    return validDay(y, mo, d) ? out(ShDate.ymd(y, mo, d)) : null;
  }
  // 只有"N号"：本月（已过则下个月）
  if ((m = s.match(/^([\d一二三四五六七八九十]+)[日号]$/))) {
    const d = num(m[1]!);
    if (d === null) return null;
    let base = ShDate.ymd(today.y, today.m, 1);
    if (
      !validDay(base.y, base.m, d) ||
      (prefer === 'future' && ShDate.ymd(base.y, base.m, d).utcMs < today.utcMs)
    ) {
      base = ShDate.ymd(today.y, today.m + 1, 1);
    }
    return validDay(base.y, base.m, d) ? out(ShDate.ymd(base.y, base.m, d)) : null;
  }
  return null;
}

/** 当前时间，给"获取当前时间"工具用 */
export function currentTime(now: Date = new Date()) {
  const t = ShDate.today(now);
  const sh = new Date(now.getTime() + 8 * 3600_000);
  const hh = String(sh.getUTCHours()).padStart(2, '0');
  const mm = String(sh.getUTCMinutes()).padStart(2, '0');
  return {
    timezone: 'Asia/Shanghai',
    date: t.iso(),
    weekday: `周${WEEK[t.dow]}`,
    time: `${hh}:${mm}`,
    display: `${out(t).display} ${hh}:${mm}`,
  };
}

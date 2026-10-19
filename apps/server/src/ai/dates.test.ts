import { describe, expect, it } from 'vitest';
import { ShDate, currentTime, resolveDate } from './dates.ts';

/** 北京时间 2026-10-18 周日（PRD 7.3 示例里"下周三"回显的就是"10月21日 周三"） */
const NOW = new Date('2026-10-18T04:00:00Z');
const d = (text: string, prefer?: 'future' | 'nearest' | 'past', now = NOW) =>
  resolveDate(text, now, prefer)?.display ?? null;

describe('相对日期（基准：北京时间 2026-10-18 周日）', () => {
  it('今天、明天、后天、大后天、昨天', () => {
    expect(d('今天')).toBe('10月18日 周日');
    expect(d('明天')).toBe('10月19日 周一');
    expect(d('后天')).toBe('10月20日 周二');
    expect(d('大后天')).toBe('10月21日 周三');
    expect(d('昨天')).toBe('10月17日 周六');
  });

  it('下周三 = 10月21日 周三（和 PRD 示例一致）', () => {
    expect(d('下周三')).toBe('10月21日 周三');
    expect(d('下星期三')).toBe('10月21日 周三');
    expect(d('下个周三')).toBe('10月21日 周三');
    expect(d('下礼拜三')).toBe('10月21日 周三');
  });

  it('周一为一周的开始：周日说"下周一"是明天，"本周日"是今天', () => {
    expect(d('下周一')).toBe('10月19日 周一');
    expect(d('本周日')).toBe('10月18日 周日');
    expect(d('这周三')).toBe('10月14日 周三'); // 本周（周一 10-12 起）的周三，已经过去
    expect(d('上周五')).toBe('10月9日 周五');
    expect(d('下下周一')).toBe('10月26日 周一');
  });

  it('单说"周X"：今天或之后最近的一个', () => {
    expect(d('周三')).toBe('10月21日 周三');
    expect(d('周日')).toBe('10月18日 周日'); // 今天就是周日
    expect(d('周六')).toBe('10月24日 周六');
    expect(d('星期天')).toBe('10月18日 周日');
  });

  it('周末、月底、月初', () => {
    expect(d('周末')).toBe('10月24日 周六');
    expect(d('月底')).toBe('10月31日 周六');
    expect(d('本月底')).toBe('10月31日 周六');
    expect(d('下月底')).toBe('11月30日 周一');
    expect(d('下月初')).toBe('11月1日 周日');
    expect(d('月初')).toBe('10月1日 周四');
  });

  it('N天后、N周后、N天前', () => {
    expect(d('3天后')).toBe('10月21日 周三');
    expect(d('三天后')).toBe('10月21日 周三');
    expect(d('一周后')).toBe('10月25日 周日');
    expect(d('两天前')).toBe('10月16日 周五');
    expect(d('十天之后')).toBe('10月28日 周三');
  });

  it('N号、下个月N号、M月D日、M/D', () => {
    expect(d('25号')).toBe('10月25日 周日');
    expect(d('10号')).toBe('11月10日 周二'); // 本月 10 号已过，取下个月
    expect(d('下个月5号')).toBe('11月5日 周四');
    expect(d('10月21日')).toBe('10月21日 周三');
    expect(d('10月21号')).toBe('10月21日 周三');
    expect(d('10/21')).toBe('10月21日 周三');
    expect(d('十月二十一日')).toBe('10月21日 周三');
  });

  it('没写年份的 M月D日：已过去的按偏好取明年、今年或最近的一次', () => {
    expect(resolveDate('1月5日', NOW, 'future')!.date).toBe('2027-01-05');
    expect(resolveDate('1月5日', NOW, 'past')!.date).toBe('2026-01-05');
    expect(resolveDate('10月1日', NOW, 'nearest')!.date).toBe('2026-10-01');
    expect(resolveDate('12月1日', NOW, 'nearest')!.date).toBe('2026-12-01');
  });

  it('完整日期', () => {
    expect(resolveDate('2026-10-21', NOW)!.date).toBe('2026-10-21');
    expect(resolveDate('2026年10月21日', NOW)!.date).toBe('2026-10-21');
    expect(resolveDate('2027/1/5', NOW)!.display).toBe('1月5日 周二');
  });

  it('带钟点的说法只取日期部分', () => {
    expect(d('明天晚上8点')).toBe('10月19日 周一');
    expect(d('下周三晚上')).toBe('10月21日 周三');
    expect(d('周五下午三点')).toBe('10月23日 周五');
    expect(d('明天，')).toBe('10月19日 周一');
  });

  it('不存在的日期、说不清的说法返回 null，交给用户补充', () => {
    expect(d('2026-02-30')).toBeNull();
    expect(d('2月30日')).toBeNull();
    expect(d('31号', 'future', new Date('2026-02-10T04:00:00Z'))).toBe('3月31日 周二'); // 2 月没有 31 号，顺延到 3 月
    expect(d('下周')).toBeNull();
    expect(d('最近')).toBeNull();
    expect(d('尽快')).toBeNull();
    expect(d('')).toBeNull();
    expect(d('13月1日')).toBeNull();
  });

  it('跨年和月末边界', () => {
    const dec = new Date('2026-12-30T04:00:00Z'); // 周三
    expect(d('下月初', 'future', dec)).toBe('1月1日 周五');
    expect(d('下周三', 'future', dec)).toBe('1月6日 周三');
    expect(d('月底', 'future', dec)).toBe('12月31日 周四');
    expect(d('下月底', 'future', dec)).toBe('1月31日 周日');
    const feb = new Date('2028-02-10T04:00:00Z'); // 闰年
    expect(d('月底', 'future', feb)).toBe('2月29日 周二');
  });

  it('基准按北京时间：UTC 的 16:30 已经是北京时间的第二天', () => {
    const late = new Date('2026-10-18T16:30:00Z'); // 北京时间 10-19 00:30
    expect(d('今天', 'future', late)).toBe('10月19日 周一');
    expect(ShDate.today(late).iso()).toBe('2026-10-19');
  });
});

describe('当前时间', () => {
  it('北京时间的日期、星期、钟点', () => {
    expect(currentTime(new Date('2026-10-18T04:05:00Z'))).toEqual({
      timezone: 'Asia/Shanghai',
      date: '2026-10-18',
      weekday: '周日',
      time: '12:05',
      display: '10月18日 周日 12:05',
    });
  });
});

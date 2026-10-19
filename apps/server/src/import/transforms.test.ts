import { describe, expect, it } from 'vitest';
import {
  applyTransform,
  excelSerialToDate,
  normalizePlatform,
  parseBool,
  parseDate,
  parseFollowers,
  parseInteger,
  parseMoneyCents,
  parsePercent,
  parsePhone,
  splitMulti,
} from './transforms.ts';

const NOW = new Date('2026-10-18T04:00:00Z'); // 北京时间 2026-10-18
const val = (r: { ok: boolean; value?: unknown }) => (r.ok ? r.value : 'ERR');

describe('日期', () => {
  it('Excel 序列号', () => {
    expect(excelSerialToDate(25569)).toBe('1970-01-01');
    expect(val(parseDate(46082, NOW))).toBe('2026-03-01');
    expect(val(parseDate(46082.5, NOW))).toBe('2026-03-01'); // 带时间的序列号只取日期
  });

  it('常见写法', () => {
    for (const s of [
      '2026/3/1',
      '2026-03-01',
      '2026.3.1',
      '2026年3月1日',
      '2026 年 3 月 1 日',
      '20260301',
      '2026/03/01 10:30',
      '46082',
    ]) {
      expect(val(parseDate(s, NOW)), s).toBe('2026-03-01');
    }
  });

  it('Date 对象按本地年月日取值', () => {
    expect(val(parseDate(new Date(2026, 2, 1), NOW))).toBe('2026-03-01');
  });

  it('缺年份：按当前年补全并提示', () => {
    const r = parseDate('3月1日', NOW);
    expect(r).toEqual({ ok: true, value: '2026-03-01', warning: '缺少年份，已按 2026 年处理' });
    expect(val(parseDate('3/1', NOW))).toBe('2026-03-01');
  });

  it('不存在的日期和乱写的内容被拒绝', () => {
    expect(parseDate('2026-02-30', NOW).ok).toBe(false);
    expect(parseDate('2026/13/1', NOW).ok).toBe(false);
    expect(parseDate('下周三', NOW).ok).toBe(false); // 相对日期不在导入里猜
    expect(parseDate('', NOW).ok).toBe(false);
  });
});

describe('金额（存为整数分）', () => {
  it.each([
    ['¥1,299.00', 129900],
    ['1299', 129900],
    ['1299元', 129900],
    ['1.2万', 1200000],
    ['1.2w', 1200000],
    ['3k', 300000],
    ['3K', 300000],
    ['0.5万', 500000],
    ['￥ 99.9', 9990],
    [1299, 129900],
    [19.9, 1990],
  ])('%s → %s 分', (raw, cents) => {
    expect(val(parseMoneyCents(raw))).toBe(cents);
  });

  it('不产生浮点误差：1.15 万 = 11500 元', () => {
    expect(val(parseMoneyCents('1.15万'))).toBe(1150000);
    expect(val(parseMoneyCents('0.07'))).toBe(7);
  });

  it('负数和无法识别的写法被拒绝', () => {
    expect(parseMoneyCents('-5').ok).toBe(false);
    expect(parseMoneyCents('面议').ok).toBe(false);
    expect(parseMoneyCents('1.2.3').ok).toBe(false);
  });
});

describe('粉丝数', () => {
  it.each([
    ['12.3w', 123000],
    ['1.2万', 12000],
    ['3k', 3000],
    ['1,234', 1234],
    ['1.5亿', 150000000],
    ['8000', 8000],
    [56789, 56789],
    ['12.3W', 123000],
  ])('%s → %s', (raw, n) => {
    expect(val(parseFollowers(raw))).toBe(n);
  });

  it('无法识别的被拒绝', () => {
    expect(parseFollowers('很多').ok).toBe(false);
    expect(parseFollowers('-3').ok).toBe(false);
  });
});

describe('百分比', () => {
  it.each([
    ['20%', 20],
    ['20％', 20],
    ['20个点', 20],
    ['20 个点', 20],
    ['22.5%', 22.5],
    ['0.2', 20],
    [0.25, 25],
    ['25', 25],
    [30, 30],
    ['100%', 100],
  ])('%s → %s', (raw, n) => {
    expect(val(parsePercent(raw))).toBe(n);
  });

  it('超范围或写法不对被拒绝', () => {
    expect(parsePercent('120%').ok).toBe(false);
    expect(parsePercent('二十个点').ok).toBe(false);
    expect(parsePercent('-5%').ok).toBe(false);
  });
});

describe('平台归一', () => {
  it.each([
    ['红书', '小红书'],
    ['XHS', '小红书'],
    ['xhs', '小红书'],
    ['小红书', '小红书'],
    [' 小红书 ', '小红书'],
    ['RedNote', '小红书'],
    ['抖音', '抖音'],
    ['DY', '抖音'],
    ['Douyin', '抖音'],
    ['视频号', '视频号'],
    ['微信视频号', '视频号'],
  ])('%s → %s', (raw, p) => {
    expect(val(normalizePlatform(raw))).toBe(p);
  });

  it('不认识的平台被拒绝，不乱猜', () => {
    expect(normalizePlatform('快手').ok).toBe(false);
    expect(normalizePlatform('B站').ok).toBe(false);
  });
});

describe('多值拆分', () => {
  it('按 / 、 , ， ； | 换行拆分并去重去空', () => {
    expect(splitMulti('小红书/抖音')).toEqual(['小红书', '抖音']);
    expect(splitMulti('女装、 美妆，穿搭;女装')).toEqual(['女装', '美妆', '穿搭']);
    expect(splitMulti('A\nB|C')).toEqual(['A', 'B', 'C']);
    expect(splitMulti('')).toEqual([]);
  });
});

describe('其他', () => {
  it('是/否、整数、手机号', () => {
    expect(val(parseBool('是'))).toBe(true);
    expect(val(parseBool('No'))).toBe(false);
    expect(parseBool('也许').ok).toBe(false);
    expect(val(parseInteger('3'))).toBe(3);
    expect(parseInteger('2.5').ok).toBe(false);
    expect(val(parsePhone('138 1234-5678'))).toBe('13812345678');
    expect(val(parsePhone(13812345678))).toBe('13812345678');
  });

  it('applyTransform 按类型分发', () => {
    expect(val(applyTransform('money', '1.2万'))).toBe(1200000);
    expect(val(applyTransform('multi', 'a/b'))).toEqual(['a', 'b']);
    expect(val(applyTransform('text', 13812345678))).toBe('13812345678');
    expect(val(applyTransform('platform', '红书'))).toBe('小红书');
  });
});

import { describe, expect, it } from 'vitest';
import { commissionWarnings, normText, verifyCommission, verifyMoneyCents } from './verify.ts';

const ORIGINAL =
  '刚和小美的经纪人聊了，A001 佣金 25 个点，坑位费一万二，B002 说是20%，报价 ¥1,500，另外 C003 给 1.2万，样衣明天寄 S、M 各一件';

describe('佣金逐字核对', () => {
  it('和原文一致：25 个点、20%、全角、空格都能对上', () => {
    expect(() => verifyCommission(25, '佣金 25 个点', ORIGINAL)).not.toThrow();
    expect(() => verifyCommission(25, '25个点', ORIGINAL)).not.toThrow(); // 引用时去掉空格也行
    expect(() => verifyCommission(20, '说是20%', ORIGINAL)).not.toThrow();
    expect(() => verifyCommission(20, '20%', '佣金２０％吧')).not.toThrow(); // 全角
    expect(() => verifyCommission(22.5, '22.5个点', '给你 22.5个点')).not.toThrow();
    expect(() => verifyCommission(25, '二十五个点', '佣金二十五个点')).not.toThrow(); // 中文数字
  });

  it('数值对不上：拒绝，并说明原文是多少', () => {
    expect(() => verifyCommission(30, '佣金 25 个点', ORIGINAL)).toThrow(
      /数值和原文对不上.*25.*30/,
    );
    expect(() => verifyCommission(2.5, '佣金 25 个点', ORIGINAL)).toThrow(/对不上/);
  });

  it('出处不在原文里（模型编的或推算出来的）：拒绝', () => {
    expect(() => verifyCommission(25, '佣金 30 个点', ORIGINAL)).toThrow(/不在用户的原文里/);
    expect(() => verifyCommission(25, '', ORIGINAL)).toThrow(/缺少原文出处/);
    expect(() => verifyCommission(25, '点', ORIGINAL)).toThrow(/缺少原文出处/);
  });

  it('没有单位：拒绝（不能把"25"当成佣金）', () => {
    expect(() => verifyCommission(25, '佣金 25', '佣金 25 吧')).toThrow(/必须带单位/);
    expect(() => verifyCommission(25, 'A001 佣金', ORIGINAL)).toThrow(/必须带单位/);
  });

  it('超出范围：拒绝', () => {
    expect(() => verifyCommission(0, '0%', '佣金 0%')).toThrow(/0 到 100/);
    expect(() => verifyCommission(120, '120%', '佣金 120%')).toThrow(/0 到 100/);
  });
});

describe('金额逐字核对（换算成分）', () => {
  it('¥ / 元 / 万 / w / k 都能换算并对上', () => {
    expect(() => verifyMoneyCents(150000, '报价 ¥1,500', ORIGINAL)).not.toThrow();
    expect(() => verifyMoneyCents(1200000, 'C003 给 1.2万', ORIGINAL)).not.toThrow();
    expect(() => verifyMoneyCents(300000, '3k', '报价 3k')).not.toThrow();
    expect(() => verifyMoneyCents(99900, '999元', '一口价999元')).not.toThrow();
    expect(() => verifyMoneyCents(129900, '￥１２９９', '直播价￥１２９９')).not.toThrow();
  });

  it('数值或单位换算错：拒绝（把 1.2 万当成 1200 元、1.2 万当成 12 万都不行）', () => {
    expect(() => verifyMoneyCents(120000, '给 1.2万', '给 1.2万')).toThrow(/对不上.*12000.*1200/);
    expect(() => verifyMoneyCents(12000000, '给 1.2万', '给 1.2万')).toThrow(/对不上/);
  });

  it('没有单位 / 出处不在原文里：拒绝', () => {
    expect(() => verifyMoneyCents(150000, '报价 1500', '报价 1500')).toThrow(/必须带单位/);
    expect(() => verifyMoneyCents(150000, '报价 ¥2,000', ORIGINAL)).toThrow(/不在用户的原文里/);
  });

  it('不是整数分：拒绝', () => {
    expect(() => verifyMoneyCents(1500.5, '15元', '15元')).toThrow(/整数/);
    expect(() => verifyMoneyCents(-100, '1元', '1元')).toThrow(/整数/);
  });
});

describe('异常佣金警告', () => {
  it('超过 50% 警告', () => {
    expect(commissionWarnings(60, [])).toEqual(['佣金 60% 超过 50%，请再核对']);
    expect(commissionWarnings(50, [])).toEqual([]);
  });
  it('明显偏离历史值警告：相差 10 个点以上，或超过 1.5 倍 / 不到一半', () => {
    expect(commissionWarnings(35, [20, 22])[0]).toMatch(/偏离.*历史约 21%/);
    expect(commissionWarnings(30, [20])[0]).toMatch(/偏离/);
    expect(commissionWarnings(9, [20])[0]).toMatch(/偏离/);
    expect(commissionWarnings(22, [20, 25])).toEqual([]);
    expect(commissionWarnings(5, [4])).toEqual([]); // 小数值，差值和倍数都不大
  });
  it('没有历史值时只看 50%', () => {
    expect(commissionWarnings(40, [])).toEqual([]);
    expect(commissionWarnings(60, [20])).toHaveLength(2);
  });
});

describe('文本归一', () => {
  it('全角、空格、大小写', () => {
    expect(normText(' ２５ ％ ABC ')).toBe('25%abc');
  });
});

import { describe, expect, it } from 'vitest';
import { dateShanghai, todayShanghai } from './automation.ts';

describe('北京时间日期换算', () => {
  it('UTC 时间过了 16:00 就是北京时间的第二天（不能直接截前 10 位）', () => {
    expect(dateShanghai('2026-10-19T16:01:00.000Z')).toBe('2026-10-20');
    expect(dateShanghai('2026-10-19T15:59:59.000Z')).toBe('2026-10-19');
  });

  it('纯日期原样返回', () => {
    expect(dateShanghai('2026-10-19')).toBe('2026-10-19');
  });

  it('今天按北京时间计算', () => {
    expect(todayShanghai(new Date('2026-10-19T16:30:00Z'))).toBe('2026-10-20');
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyCommission, verifyMoneyCents } from './verify.ts';
import { OcrService, WindowsOcr, cleanOcrLines } from './ocr.ts';

const SAMPLE = path.join(import.meta.dirname, 'fixtures', 'chat-sample.png');

/** Windows OCR 对 fixtures/chat-sample.png（虚构的聊天截图）的原始输出 */
const RAW = [
  '小 美 的 经 纪 人 （ 示 例 ）',
  '刚 和 你 们 商 务 聊 了 ， 这 场 佣 全 25 个 点',
  '坑 位 费 1 ． 2 万 ， 下 周 三 晚 上 8 点 开 播',
  '样 衣 明 天 寄 ， A001 针 织 外 套 米 白 S 、 M 各 一 件',
  '收 件 人 ： 测 试 乙 手 机 ： 13800001111',
  '地 址 ： 浙 江 省 杭 州 市 余 杭 区 文 一 西 路 969 号 3 幢 502 室',
  '微 信 ： demo agent 88 ， 到 了 麻 烦 回 我 一 下',
];

describe('OCR 结果清理', () => {
  it('去掉汉字之间的空格，合并被拆开的小数点，保留数字和英文之间的空格', () => {
    const text = cleanOcrLines(RAW);
    const lines = text.split('\n');
    expect(lines[0]).toBe('小美的经纪人（示例）');
    expect(lines[1]).toContain('商务聊了，这场佣');
    expect(lines[1]).toContain('25 个点');
    expect(lines[2]).toContain('1.2 万');
    expect(lines[2]).toContain('下周三晚上 8 点开播');
    expect(lines[3]).toContain('A001 针织外套米白 S、M 各一件');
    expect(lines[5]).toContain('浙江省杭州市余杭区文一西路 969 号 3 幢 502 室');
  });

  it('清理后的文字能通过佣金、金额的逐字核对', () => {
    const text = cleanOcrLines(RAW);
    expect(() => verifyCommission(25, '25 个点', text)).not.toThrow();
    expect(() => verifyMoneyCents(1200000, '1.2万', text)).not.toThrow();
    // 识别错成"佣全"也不影响数字核对；但原文里没有的数字仍会被拒绝
    expect(() => verifyCommission(30, '30 个点', text)).toThrow();
  });

  it('空行丢弃', () => {
    expect(cleanOcrLines(['', '  ', 'a b'])).toBe('a b');
  });
});

describe('OcrService', () => {
  it('不是图片、太大的文件被拒绝', async () => {
    const svc = new OcrService({
      name: 'fake',
      check: async () => ({ ok: true }),
      recognize: async () => ['x'],
    });
    await expect(svc.recognize(new Uint8Array(10), 'application/pdf')).rejects.toThrow(/PNG/);
    await expect(svc.recognize(new Uint8Array(11 * 1024 * 1024), 'image/png')).rejects.toThrow(
      /10 MB/,
    );
  });

  it('引擎不可用时给出原因；识别不出文字时提示；临时文件识别后删除', async () => {
    const bad = new OcrService({
      name: 'fake',
      check: async () => ({ ok: false, reason: '没有语言包' }),
      recognize: async () => [],
    });
    await expect(bad.recognize(new Uint8Array(10), 'image/png')).rejects.toThrow('没有语言包');
    let seen = '';
    const empty = new OcrService({
      name: 'fake',
      check: async () => ({ ok: true }),
      recognize: async (p) => {
        seen = p;
        expect(fs.existsSync(p)).toBe(true);
        return [];
      },
    });
    await expect(empty.recognize(new Uint8Array(10), 'image/png')).rejects.toThrow(
      /没有识别出文字/,
    );
    expect(fs.existsSync(seen)).toBe(false);
  });
});

const windows = new WindowsOcr();
const available = process.platform === 'win32' && (await windows.check()).ok;
describe.skipIf(!available)('Windows 自带 OCR（真实识别）', () => {
  it('识别虚构的聊天截图：金额、佣金、款号、手机号都能读出来', async () => {
    const svc = new OcrService(windows);
    const res = await svc.recognize(new Uint8Array(fs.readFileSync(SAMPLE)), 'image/png');
    expect(res.engine).toBe('Windows 自带 OCR');
    expect(res.text).toContain('25');
    expect(res.text.replace(/ /g, '')).toContain('1.2万');
    expect(res.text).toContain('A001');
    expect(res.text).toContain('13800001111');
    expect(res.text).toContain('下周三');
    // 识别结果可以直接用来核对
    expect(() => verifyCommission(25, '25 个点', res.text)).not.toThrow();
  }, 30_000);
});

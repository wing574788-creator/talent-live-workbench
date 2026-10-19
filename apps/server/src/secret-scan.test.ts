import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error 纯 JS 脚本，没有类型声明
import { listFiles, scanFiles, scanText } from '../../../scripts/scan-secrets.mjs';

const root = path.resolve(import.meta.dirname, '../../..');

describe('密钥扫描', () => {
  it('整个工作区没有疑似写死的密钥、令牌、私钥', () => {
    const hits = scanFiles(root, listFiles(root, true));
    expect(
      hits.map(
        (h: { file: string; line: number; rule: string }) => `${h.file}:${h.line} ${h.rule}`,
      ),
    ).toEqual([]);
  });

  it('规则能识别常见的真密钥写法，不误伤占位符和测试假值', () => {
    const fake = (s: string) => scanText('x', s).length;
    expect(fake('const k = "sk-' + 'a1b2c3d4e5f6g7h8i9j0k1l2"')).toBe(1);
    expect(fake('AKIA' + 'ABCDEFGHIJKLMNOP')).toBe(1);
    expect(fake('-----BEGIN ' + 'PRIVATE KEY-----')).toBe(1);
    expect(fake('apiKey: "' + 'abcdefghij0123456789ZZ"')).toBe(1);
    expect(fake('postgres://user:pass' + 'word@host/db')).toBe(1);
    expect(fake("apiKey: 'runtime-injected'")).toBe(0);
    expect(fake("ctx.store.setKey('mock', 'mock-key-0123456789')")).toBe(0);
  });
});

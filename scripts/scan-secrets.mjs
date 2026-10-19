/**
 * 密钥扫描：提交前（.githooks/pre-commit）和测试里（secret-scan.test.ts）都会跑。
 * 用法：node scripts/scan-secrets.mjs [--all]   默认只扫暂存区，--all 扫整个工作区
 * 发现疑似密钥会列出文件和行号并以退出码 1 结束。测试里的假密钥请用 mock-key-xxxx 这类不像真密钥的写法。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RULES = [
  ['OpenAI/DeepSeek 风格的 API Key', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['Anthropic 风格的 API Key', /\bsk-ant-[A-Za-z0-9_-]{10,}/],
  ['AWS Access Key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub Token', /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ['Google API Key', /\bAIza[0-9A-Za-z_-]{30,}/],
  ['Slack Token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/],
  ['私钥', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/],
  ['带密码的连接串', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]{3,}@[^\s/]+/i],
  [
    '疑似写死的密钥/口令',
    /(?:api[_-]?key|secret|token|passw(?:or)?d)["']?\s*[:=]\s*["'][A-Za-z0-9/_+=.-]{20,}["']/i,
  ],
];

const norm = (f) => f.replace(/\\/g, '/');
/** 这些文件不扫：锁文件、二进制、依赖 */
const SKIP =
  /(^|\/)(node_modules|\.git|dist)\/|pnpm-lock\.yaml$|\.(png|jpe?g|xlsx|db|ico|woff2?)$/i;
/** 规则本身的文件里有样例正则，跳过 */
const SELF = /scripts\/scan-secrets\.mjs$|secret-scan\.test\.ts$/;

export function scanText(file, text) {
  const hits = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const [name, re] of RULES) if (re.test(line)) hits.push({ file, line: i + 1, rule: name });
  });
  return hits;
}

export function scanFiles(root, files) {
  return files
    .filter((f) => !SKIP.test(norm(f)) && !SELF.test(norm(f)))
    .flatMap((f) => {
      const abs = path.join(root, f);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return [];
      return scanText(f, fs.readFileSync(abs, 'utf8'));
    });
}

export function listFiles(root, all) {
  if (!all) {
    return execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACM', '-z'], {
      cwd: root,
      encoding: 'utf8',
    })
      .split('\0')
      .filter(Boolean);
  }
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir, e.name);
      if (SKIP.test(rel + (e.isDirectory() ? '/' : ''))) continue;
      if (e.isDirectory()) walk(rel);
      else out.push(rel);
    }
  };
  walk('.');
  return out.map((f) => f.replace(/^\.\//, ''));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const hits = scanFiles(root, listFiles(root, process.argv.includes('--all')));
  if (hits.length) {
    console.error('发现疑似密钥，已阻止：');
    for (const h of hits) console.error(`  ${h.file}:${h.line}  ${h.rule}`);
    console.error(
      '如果是测试用的假值，请改成 mock-key-xxxx 这类写法；真密钥请只放在设置页（存到本机 secrets.json）。',
    );
    process.exit(1);
  }
  console.log('未发现疑似密钥。');
}

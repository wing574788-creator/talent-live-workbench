/**
 * 换模型前跑一遍：pnpm --filter @workbench/server ai:regress [用例id ...]
 * 用的是临时数据库 + 虚构数据，模型配置（提供方、Key、用途）复制自工作台数据目录
 * （WORKBENCH_DATA_DIR，默认同服务），跑完临时目录整个删除。
 * 提示：会真实调用模型，每个用例数次请求；结果受模型随机性影响，可多跑几次看通过率。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveDataDir } from '../../config.ts';
import { openDb, runMigrations } from '../../db/index.ts';
import { createDomain } from '../../domain/index.ts';
import { createAiContext } from '../index.ts';
import { runRegression } from './runner.ts';

const src = resolveDataDir();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-regress-'));
for (const f of ['ai-config.json', 'secrets.json']) {
  const p = path.join(src, f);
  if (fs.existsSync(p)) fs.copyFileSync(p, path.join(tmp, f));
}
const { db, sqlite } = openDb(tmp);
runMigrations(db);
const ctx = createAiContext(createDomain(db), tmp);

const only = process.argv.slice(2);
console.log(`回归集开始（${only.length ? only.join(', ') : '全部用例'}）…\n`);
const results = await runRegression(ctx, sqlite, {
  only,
  onResult: (r) => {
    console.log(`${r.passed ? '✔ 通过' : '✘ 失败'}  ${r.id}  ${r.title}`);
    console.log(`        工具调用：${r.tools.join(' → ') || '（无）'}`);
    if (r.error) console.log(`        出错：${r.error}`);
    for (const f of r.failures) console.log(`        - ${f}`);
  },
});
const ok = results.filter((r) => r.passed).length;
console.log(`\n通过 ${ok} / ${results.length}`);
sqlite.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(ok === results.length ? 0 : 1);

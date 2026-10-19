/**
 * 示例数据（全部虚构）+ 撤销演示：pnpm db:seed
 * 默认写入一个临时库，不碰真实数据目录；加 --real 才写入配置的数据目录。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.ts';
import { createDomain } from '../domain/index.ts';
import { appliedOf, type WriteResult } from '../domain/types.ts';
import { openDb, runMigrations } from './index.ts';

const real = process.argv.includes('--real');
const dir = real ? config.dataDir : fs.mkdtempSync(path.join(os.tmpdir(), 'wb-seed-'));
const { db, sqlite } = openDb(dir);
runMigrations(db);
const d = createDomain(db);

const batch = d.newBatchId();
const actor = d.userActor({ batchId: batch, source: '示例数据脚本' });
const ok = (r: WriteResult) => appliedOf(r).row;

const product = ok(
  d.entity('product').create(actor, { styleNo: 'A001', name: '羊毛大衣', livePriceCents: 129900 }),
);
for (const [color, size] of [
  ['黑色', 'S'],
  ['黑色', 'M'],
  ['驼色', 'M'],
] as const) {
  d.entity('product_variant').create(actor, { productId: product.id, color, size });
}
const inf = ok(
  d.entity('influencer').create(actor, { nickname: '示例达人小美', categoryTags: ['女装'] }),
);
const acc = ok(
  d
    .entity('platform_account')
    .create(actor, { influencerId: inf.id, platform: '小红书', accountId: 'demo_xm_001' }),
);
const coop = ok(
  d.entity('cooperation').create(actor, {
    influencerId: inf.id,
    platformAccountId: acc.id,
    stage: '洽谈中',
    followStatus: '报价中',
    nextFollowDate: '2026-10-21',
  }),
);
d.entity('cooperation_product').create(actor, {
  cooperationId: coop.id,
  productId: product.id,
  commissionPct: 20,
});

console.log(`已写入示例数据（批次 ${batch}），数据目录：${dir}`);
console.log(
  '商品数：',
  d.entity('product').list().length,
  '达人数：',
  d.entity('influencer').list().length,
);

const res = d.review.undoBatch(d.userActor(), batch);
console.log(`整批撤销：成功 ${res.undone.length} 条，冲突 ${res.conflicts.length} 条`);
console.log(
  '撤销后商品数：',
  d.entity('product').list().length,
  '达人数：',
  d.entity('influencer').list().length,
);

sqlite.close();
if (!real) fs.rmSync(dir, { recursive: true, force: true });

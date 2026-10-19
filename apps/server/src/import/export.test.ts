import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { openDb, runMigrations } from '../db/index.ts';
import { createDomain, type Domain } from '../domain/index.ts';
import { autoConfigs } from './analyze.ts';
import { commitImport, dryRun } from './engine.ts';
import { EXPORT_ENTITIES, exportAll, exportList, writeWorkbook } from './export.ts';
import { parseFile } from './parse.ts';
import { buildSampleWorkbook } from './sample-data.ts';
import type { Decisions } from './types.ts';

const NOW = new Date('2026-10-18T04:00:00Z');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-export-'));
const A = openDb(dir, 'a.db');
const B = openDb(dir, 'b.db');
runMigrations(A.db);
runMigrations(B.db);
let a: Domain;
let b: Domain;

afterAll(() => {
  A.sqlite.close();
  B.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const TABLES = [
  'change_log',
  'pending_changes',
  'import_batches',
  'field_defs',
  'cooperation_products',
  'cooperations',
  'follow_ups',
  'sample_return_items',
  'sample_returns',
  'sample_writeoffs',
  'sample_shipment_items',
  'sample_shipments',
  'influencer_contacts',
  'influencer_addresses',
  'platform_accounts',
  'influencers',
  'contacts',
  'product_variants',
  'products',
];
beforeEach(() => {
  for (const t of TABLES) {
    A.sqlite.exec(`delete from ${t}`);
    B.sqlite.exec(`delete from ${t}`);
  }
  a = createDomain(A.db);
  b = createDomain(B.db);
});

/** 把样例导入库 A */
function seedA() {
  const parsed = parseFile(buildSampleWorkbook(), '示例.xlsx');
  const configs = autoConfigs(parsed);
  configs.find((c) => c.sheet === '合作跟踪')!.enumMap = { stage: { 火星: '暂缓' } };
  commitImport(
    a,
    parsed,
    configs,
    { 达人库: { duplicates: 'new' } },
    { fileName: '示例.xlsx', now: NOW },
  );
}

describe('列表导出', () => {
  it('达人：每个账号一行，金额按元、标签用 / 连接，自定义字段（含导入原始值）作为列', () => {
    seedA();
    const s = exportList(a, 'influencer');
    expect(s.name).toBe('达人');
    expect(s.headers).toEqual(
      expect.arrayContaining([
        '达人昵称',
        '平台',
        '账号ID',
        '粉丝数',
        '参考佣金（%）',
        '参考报价',
        '导入原始值',
      ]),
    );
    const h = (n: string) => s.headers.indexOf(n);
    const row = s.rows.find((r) => r[h('账号ID')] === 'demo_a_001')!;
    expect(row[h('达人昵称')]).toBe('林小满');
    expect(row[h('类目标签')]).toBe('女装/穿搭');
    expect(row[h('参考报价')]).toBe(1500); // 150000 分 → 1500 元
    expect(row[h('粉丝数')]).toBe(123000);
    expect(s.rows.filter((r) => r[h('达人昵称')] === '顾北北')).toHaveLength(2); // 两个平台账号两行
    const e = s.rows.find((r) => r[h('达人昵称')] === '许知意')!;
    expect(String(e[h('导入原始值')])).toContain('粉丝数：很多');
  });

  it('按筛选条件导出：只导出筛出来的行', () => {
    seedA();
    const s = exportList(a, 'influencer', { q: '林小满' });
    expect(new Set(s.rows.map((r) => r[0]))).toEqual(new Set(['林小满', '林小满.']));
    const dy = exportList(a, 'influencer', { platform: '抖音' });
    expect(dy.rows.every((r) => r[dy.headers.indexOf('平台')] === '抖音')).toBe(true);
  });

  it('商品一个规格一行；联系人带关联达人；合作一个商品一行；寄样一条明细一行', () => {
    seedA();
    expect(exportList(a, 'product').rows).toHaveLength(6);
    const contacts = exportList(a, 'contact');
    const wang = contacts.rows.find((r) => r[contacts.headers.indexOf('手机')] === '13800000001')!;
    expect(wang[contacts.headers.indexOf('关联达人')]).toBe('林小满/陈一诺');
    expect(wang[contacts.headers.indexOf('主要对接人')]).toBe('是');
    expect(exportList(a, 'cooperation').rows.length).toBeGreaterThanOrEqual(5);
    expect(exportList(a, 'shipment').rows).toHaveLength(4);
  });

  it('超过 500 条也能导出完整（分页取完）', () => {
    const user = a.userActor();
    for (let i = 0; i < 620; i++)
      a.entity('product').create(user, {
        styleNo: `S${String(i).padStart(4, '0')}`,
        name: `商品${i}`,
      });
    expect(exportList(a, 'product').rows).toHaveLength(620);
  });
});

describe('全量导出：每类实体一个 sheet', () => {
  it('包含全部数据；Excel 能读回来', () => {
    seedA();
    const buf = writeWorkbook(exportAll(a));
    const parsed = parseFile(buf, 'all.xlsx');
    expect(parsed.sheets.map((s) => s.name)).toEqual([
      '商品',
      '达人',
      '联系人',
      '合作',
      '跟进记录',
      '寄样',
      '退样',
      '核销',
      '收货地址',
    ]);
    const rows = Object.fromEntries(parsed.sheets.map((s) => [s.name, s.rows.length - 1]));
    expect(rows['商品']).toBe(6);
    expect(rows['达人']).toBe(7); // 6 位达人，顾北北两个账号
    expect(rows['联系人']).toBe(3);
    expect(rows['寄样']).toBe(4);
  });

  it('表头行是真正的表头：导出的文件可以直接再导入（自动识别表头和目标）', () => {
    seedA();
    const parsed = parseFile(writeWorkbook(exportAll(a)), 'all.xlsx');
    const targets = Object.fromEntries(autoConfigs(parsed).map((c) => [c.sheet, c.target]));
    expect(targets).toMatchObject({
      商品: 'product',
      达人: 'influencer',
      联系人: 'contact',
      合作: 'cooperation',
      寄样: 'shipment',
    });
  });
});

describe('往返：导出 → 导入到全新的库，数据对得上（离开工作台的退路）', () => {
  it('商品、达人、联系人、合作、寄样', () => {
    seedA();
    const parsed = parseFile(
      writeWorkbook(EXPORT_ENTITIES.map((e) => exportList(a, e))),
      'all.xlsx',
    );
    const configs = autoConfigs(parsed);
    // 同一位达人有两个平台账号 → 导出是两行，导入时第二行会提示疑似重复：昵称完全相同的选"合并"，林小满. 是另一个人选"新建"
    const decisions: Decisions = {};
    const infCfg = configs.find((c) => c.target === 'influencer')!;
    const rows: Record<number, 'merge' | 'new'> = {};
    for (const r of dryRun(b, parsed, configs, {}, NOW).sheets.find(
      (s) => s.sheet === infCfg.sheet,
    )!.rows) {
      if (r.status === 'duplicate')
        rows[r.rowNo] = r.suspects![0]!.label === r.summary.split(' · ')[0] ? 'merge' : 'new';
    }
    expect(Object.values(rows).sort()).toEqual(['merge', 'new']);
    decisions[infCfg.sheet] = { rows };
    commitImport(b, parsed, configs, decisions, { fileName: 'all.xlsx', now: NOW });

    expect(b.entity('product').list().length).toBe(a.entity('product').list().length);
    expect(b.entity('product_variant').list().length).toBe(
      a.entity('product_variant').list().length,
    );
    expect(b.entity('influencer').list().length).toBe(a.entity('influencer').list().length);
    expect(b.entity('platform_account').list().length).toBe(
      a.entity('platform_account').list().length,
    );
    expect(b.entity('contact').list().length).toBe(a.entity('contact').list().length);
    expect(b.entity('influencer_contact').list().length).toBe(
      a.entity('influencer_contact').list().length,
    );
    expect(b.entity('cooperation').list().length).toBe(a.entity('cooperation').list().length);
    expect(b.entity('cooperation_product').list().length).toBe(
      a.entity('cooperation_product').list().length,
    );
    expect(b.entity('sample_shipment').list().length).toBe(
      a.entity('sample_shipment').list().length,
    );
    expect(b.entity('sample_shipment_item').list().length).toBe(
      a.entity('sample_shipment_item').list().length,
    );

    // 字段值一致（金额、日期、佣金、粉丝数）
    const pick = (d: Domain) =>
      d
        .entity('influencer')
        .list()
        .find((i) => i.nickname === '林小满')!;
    expect(pick(b)).toMatchObject({
      refCommissionPct: 20,
      refQuoteCents: 150000,
      categoryTags: ['女装', '穿搭'],
    });
    const prod = (d: Domain) =>
      d
        .entity('product')
        .list()
        .find((p) => p.styleNo === 'A001')!;
    expect(prod(b)).toMatchObject({
      dailyPriceCents: prod(a).dailyPriceCents,
      livePriceCents: prod(a).livePriceCents,
      finalPriceCents: prod(a).finalPriceCents,
    });
    const ship = (d: Domain) =>
      d
        .entity('sample_shipment')
        .list()
        .find((s) => s.trackingNo === 'SF0001')!;
    expect(ship(b)).toMatchObject({ status: '已寄出', shippedAt: '2026-10-05' });
    expect(b.samples.detail(pick(b).id).summary.outstanding).toBe(
      a.samples.detail(pick(a).id).summary.outstanding,
    );
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { openDb, runMigrations } from '../db/index.ts';
import { createDomain, type Domain } from '../domain/index.ts';
import { autoConfig, autoConfigs, analyzeSheet } from './analyze.ts';
import { commitImport, dryRun, rollbackBatch } from './engine.ts';
import { buildColumns } from './parse.ts';
import { parseFile } from './parse.ts';
import { buildSampleCsvGbk, buildSampleWorkbook } from './sample-data.ts';
import { applyTemplate, buildTemplate } from './templates.ts';
import type { Decisions, SheetConfig } from './types.ts';

const NOW = new Date('2026-10-18T04:00:00Z');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-import-'));
const { db, sqlite } = openDb(dir);
runMigrations(db);
let d: Domain;

afterAll(() => {
  sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const TABLES = [
  'change_log',
  'pending_changes',
  'import_batches',
  'mapping_templates',
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
  'app_settings',
  'enum_options',
];
beforeEach(() => {
  for (const t of TABLES) sqlite.exec(`delete from ${t}`);
  d = createDomain(db);
});

const parsed = () => parseFile(buildSampleWorkbook(), '钉钉导出示例.xlsx');
const count = (name: string) => d.entity(name).list().length;
const cfgOf = (name: string, configs = autoConfigs(parsed())) =>
  configs.find((c) => c.sheet === name)!;

/** 让样例能直接提交：把"火星"映射成暂缓，所有疑似重复都选"新建" */
const READY: { configs: () => SheetConfig[]; decisions: Decisions } = {
  configs: () => {
    const cs = autoConfigs(parsed());
    cfgOf('合作跟踪', cs).enumMap = { stage: { 火星: '暂缓' } };
    return cs;
  },
  decisions: { 达人库: { duplicates: 'new' } },
};
const commit = (configs = READY.configs(), decisions = READY.decisions) =>
  commitImport(d, parsed(), configs, decisions, { fileName: '钉钉导出示例.xlsx', now: NOW });

describe('分析', () => {
  it('每张表：识别表头行、猜出目标、给出列映射建议', () => {
    const p = parsed();
    const got = Object.fromEntries(p.sheets.map((s) => [s.name, analyzeSheet(s)]));
    expect(got['达人库']).toMatchObject({ target: 'influencer', header: { row: 2, rows: 1 } });
    expect(got['商品库']).toMatchObject({ target: 'product', header: { row: 1, rows: 1 } });
    expect(got['联系人']).toMatchObject({ target: 'contact', header: { row: 0, rows: 1 } });
    expect(got['合作跟踪']).toMatchObject({ target: 'cooperation', header: { row: 0, rows: 2 } });
    expect(got['寄样记录']).toMatchObject({ target: 'shipment' });
    // 两行表头合成的列名也能匹配到字段
    const coop = cfgOf('合作跟踪');
    const fields = Object.values(coop.mapping).map((m) => (m.kind === 'field' ? m.field : m.kind));
    expect(fields).toEqual(
      expect.arrayContaining([
        'influencerNickname',
        'platform',
        'stage',
        'followStatus',
        'nextFollowDate',
        'productStyleNo',
        'commissionPct',
      ]),
    );
  });
});

describe('预演：逐行标出新增 / 更新 / 疑似重复 / 警告 / 错误，不写库', () => {
  it('达人库', () => {
    const { sheets } = dryRun(d, parsed(), [cfgOf('达人库')], {}, NOW);
    const s = sheets[0]!;
    expect(s.stats).toEqual({ total: 8, new: 5, update: 1, duplicate: 1, error: 1, warning: 1 });
    const by = Object.fromEntries(s.rows.map((r) => [r.rowNo, r]));
    expect(by[4]).toMatchObject({ status: 'new', summary: '林小满 · 小红书 demo_a_001' });
    expect(by[7]!.summary).toContain('小红书 demo_d_xhs'); // "小红书/抖音" 拆开，两个账号
    expect(by[8]!.issues.map((i) => i.text).join()).toMatch(/粉丝数.*很多.*导入原始值/);
    expect(by[9]).toMatchObject({ status: 'update', existingLabel: '本次导入第 4 行' }); // 同一个账号又出现
    expect(by[10]).toMatchObject({ status: 'duplicate' }); // 昵称几乎一样 → 疑似重复，不自动合并
    expect(by[10]!.suspects![0]).toMatchObject({ label: '林小满', score: 1 });
    expect(by[11]).toMatchObject({ status: 'error' });
    expect(s.undecided).toBe(1);
    expect(by[10]!.decision).toBeUndefined(); // 疑似重复必须由用户裁决
    expect(count('influencer')).toBe(0); // 预演没有写任何东西
  });

  it('数据库里已有的账号：识别为更新，并预览会改哪些字段（敏感字段打码）', () => {
    const user = d.userActor();
    const inf = d.influencers.createWithAccounts(user, {
      influencer: { nickname: '林小满', realName: '张三丰' },
      accounts: [{ platform: '小红书', accountId: 'demo_a_001' }],
    }).influencer;
    const r = dryRun(d, parsed(), [cfgOf('达人库')], {}, NOW).sheets[0]!;
    const row4 = r.rows.find((x) => x.rowNo === 4)!;
    expect(row4).toMatchObject({ status: 'update', existingId: inf.id });
    expect(row4.changes!.map((c) => c.field)).toEqual(
      expect.arrayContaining(['categoryTags', 'refCommissionPct', 'refQuoteCents']),
    );
    expect(JSON.stringify(r)).not.toContain('张三丰');
  });

  it('合作表引用同一个文件里"将要新建"的达人和商品，也能对上；找不到的报错', () => {
    const r = dryRun(d, parsed(), [cfgOf('合作跟踪'), cfgOf('达人库'), cfgOf('商品库')], {}, NOW);
    expect(r.sheets.map((s) => s.sheet)).toEqual(['商品库', '达人库', '合作跟踪']); // 按依赖顺序处理
    const coop = r.sheets[2]!;
    const by = Object.fromEntries(coop.rows.map((x) => [x.rowNo, x]));
    expect(by[3]).toMatchObject({ status: 'new' });
    expect(by[4]).toMatchObject({ status: 'update' }); // 合并单元格延续：同一场合作的另一个商品
    expect(by[5]!.issues.map((i) => i.text).join()).toContain('缺少年份');
    expect(by[8]).toMatchObject({ status: 'error' });
    expect(by[8]!.issues.map((i) => i.text).join()).toContain('洽谈中的合作必须有下次跟进日期');
    expect(by[9]!.issues.map((i) => i.text).join()).toContain('找不到达人');
    expect(coop.unmappedEnums).toBe(1); // "火星"
    expect(
      coop.enums
        .find((e) => e.field === 'stage')!
        .values.filter((v) => !v.decided)
        .map((v) => v.raw),
    ).toEqual(['火星']);
  });

  it('枚举写法自动归一：沟通中/在聊 → 洽谈中，已定档 → 已排期，已发货 → 已寄出', () => {
    const r = dryRun(
      d,
      parsed(),
      [cfgOf('合作跟踪'), cfgOf('寄样记录'), cfgOf('达人库'), cfgOf('商品库')],
      {},
      NOW,
    );
    const stage = r.sheets
      .find((s) => s.sheet === '合作跟踪')!
      .enums.find((e) => e.field === 'stage')!;
    expect(Object.fromEntries(stage.values.map((v) => [v.raw, v.mapped]))).toMatchObject({
      沟通中: '洽谈中',
      在聊: '洽谈中',
      已定档: '已排期',
      火星: null,
    });
    const st = r.sheets
      .find((s) => s.sheet === '寄样记录')!
      .enums.find((e) => e.field === 'status')!;
    expect(Object.fromEntries(st.values.map((v) => [v.raw, v.mapped]))).toEqual({
      已发货: '已寄出',
      待发货: '待寄样',
    });
  });

  it('列映射配置问题：必填字段没映射、两列映射同一字段 → 提示且整张表不能导入', () => {
    const cfg = cfgOf('达人库');
    delete cfg.mapping['0'];
    cfg.mapping['5'] = { kind: 'field', field: 'platform' }; // 和第 1 列重复
    const s = dryRun(d, parsed(), [cfg], {}, NOW).sheets[0]!;
    expect(s.configIssues.join()).toContain('必填字段「昵称」');
    expect(s.configIssues.join()).toContain('一个字段只能对应一列');
    expect(s.stats.error).toBe(s.stats.total);
  });
});

describe('提交', () => {
  it('枚举值没处理、疑似重复没裁决、有配置问题时不能提交', () => {
    expect(() => commit(autoConfigs(parsed()), {})).toThrow(/没有对应的系统选项|疑似重复/);
    const cs = READY.configs();
    expect(() => commit(cs, {})).toThrow(/没有裁决/);
    const bad = READY.configs();
    delete cfgOf('商品库', bad).mapping['0'];
    expect(() => commit(bad, READY.decisions)).toThrow(/列映射有问题/);
    expect(count('influencer')).toBe(0);
    expect(count('import_batch')).toBe(0); // 校验失败不留下批次
  });

  it('整份样例导入：商品、达人、联系人、合作、寄样都写入，错误行单独列出，结果带行号', () => {
    const out = commit();
    const by = Object.fromEntries(out.sheets.map((s) => [s.sheet, s]));
    expect(by['商品库']).toMatchObject({ created: 4, updated: 2, failed: 0 });
    expect(by['达人库']).toMatchObject({ created: 6, failed: 1 });
    expect(by['达人库']!.errors[0]).toMatchObject({ rowNo: 11, text: '缺少昵称' });
    expect(by['联系人']).toMatchObject({ created: 3, failed: 1 });
    expect(by['合作跟踪']).toMatchObject({ created: 4, failed: 2 });
    expect(by['寄样记录']).toMatchObject({ failed: 1 });

    // 商品：款号相同的行合并成一个商品 + 多个规格
    const a001 = d
      .entity('product')
      .list()
      .find((p) => p.styleNo === 'A001')!;
    expect(count('product')).toBe(4);
    expect(
      d
        .entity('product_variant')
        .findBy('productId', a001.id)
        .map((v) => `${v.color}${v.size}`)
        .sort(),
    ).toEqual(['驼色M', '黑色M', '黑色S']);
    expect(a001).toMatchObject({
      dailyPriceCents: 199900,
      livePriceCents: 129900,
      finalPriceCents: 119900,
      price618Cents: 110000,
      status: '在售',
    });
    const c003 = d
      .entity('product')
      .list()
      .find((p) => p.styleNo === 'C003')!;
    expect(c003.dailyPriceCents).toBe(90000); // 0.09万 = 900 元

    // 无法解析的值不丢：存进"导入原始值"
    const d004 = d
      .entity('product')
      .list()
      .find((p) => p.styleNo === 'D004')!;
    expect((d004.custom as Record<string, string>).import_raw).toBe('直播价：面议');
    expect(
      d
        .entity('field_def')
        .list()
        .map((f) => `${f.entity}:${f.key}`),
    ).toEqual(expect.arrayContaining(['product:import_raw', 'influencer:import_raw']));

    // 达人：多平台拆成两个账号，写法归一，金额存分，百分比存数值
    const infs = d.entity('influencer').list();
    const a = infs.find((i) => i.nickname === '林小满')!;
    expect(a).toMatchObject({
      refCommissionPct: 20,
      refQuoteCents: 150000,
      categoryTags: ['女装', '穿搭'],
    });
    const aAcc = d.entity('platform_account').findBy('influencerId', a.id);
    expect(aAcc).toHaveLength(1);
    expect(aAcc[0]).toMatchObject({ platform: '小红书', followers: 123000, role: '博主' }); // 第二次出现的 13w 按"仅填空值"不覆盖
    const dd = infs.find((i) => i.nickname === '顾北北')!;
    expect(
      d
        .entity('platform_account')
        .findBy('influencerId', dd.id)
        .map((x) => `${x.platform}:${x.accountId}`)
        .sort(),
    ).toEqual(['小红书:demo_d_xhs', '抖音:demo_d_dy']);
    expect(
      d
        .entity('platform_account')
        .findBy('influencerId', infs.find((i) => i.nickname === '苏晚晚')!.id)[0],
    ).toMatchObject({ platform: '抖音', followers: 8000 });
    expect(infs.find((i) => i.nickname === '苏晚晚')).toMatchObject({
      refCommissionPct: 18,
      refQuoteCents: 300000,
    }); // 0.18 → 18%，3k → 3000 元
    const e = infs.find((i) => i.nickname === '许知意')!;
    expect((e.custom as Record<string, string>).import_raw).toContain('粉丝数：很多');
    expect(count('influencer')).toBe(6); // 疑似重复"林小满."选了新建

    // 联系人：手机相同的行合并进已有联系人；关联达人，第一个设为主要
    expect(count('contact')).toBe(3);
    const wang = d
      .entity('contact')
      .list()
      .find((c) => c.phone === '13800000001')!;
    expect(wang).toMatchObject({ name: '示例经纪人王', type: '经纪人', org: '示例MCN' });
    const links = d.entity('influencer_contact').findBy('contactId', wang.id);
    expect(links).toHaveLength(2);
    expect(links.every((l) => l.isPrimary)).toBe(true);

    // 合作：一场合作多个商品、各自佣金；日期、阶段按规则转换
    const coops = d.entity('cooperation').list();
    expect(coops).toHaveLength(4);
    const ca = coops.find((c) => c.influencerId === a.id)!;
    expect(ca).toMatchObject({
      stage: '洽谈中',
      followStatus: '报价中',
      nextFollowDate: '2026-10-21',
    });
    expect(
      d
        .entity('cooperation_product')
        .findBy('cooperationId', ca.id)
        .map((x) => x.commissionPct)
        .sort(),
    ).toEqual([20, 25]);
    const cb = coops.find((c) => c.nextFollowDate === '2026-10-25')!;
    expect(cb).toMatchObject({ stage: '洽谈中', followStatus: '待回复' });
    expect(coops.find((c) => c.stage === '已排期')).toMatchObject({ nextFollowDate: '2026-10-30' });
    expect(coops.find((c) => c.stage === '暂缓')).toBeDefined(); // "火星" 被映射成了暂缓

    // 寄样：同一个包裹的三行 → 一张寄样单三条明细，状态和日期转换正确
    const ship = d.entity('sample_shipment').list();
    const sf = ship.find((s) => s.trackingNo === 'SF0001')!;
    expect(sf).toMatchObject({ status: '已寄出', shippedAt: '2026-10-05', influencerId: a.id });
    expect(d.entity('sample_shipment_item').findBy('shipmentId', sf.id)).toHaveLength(3);
    expect(ship.find((s) => !s.trackingNo)).toMatchObject({ status: '待寄样' });
    expect(d.samples.detail(a.id).summary.outstanding).toBe(3); // 在外 = 已寄出的 3 件
  });

  it('导入产生的每一条写入都有变更日志，操作者是"导入"，带批次号和来源文件', () => {
    const out = commit();
    const logs = d.reviewView.listChanges({ actorType: 'import', limit: 200 }).rows;
    expect(logs.length).toBeGreaterThan(30);
    expect(
      logs.every((l) => l.batchId === out.batchId && l.source === '导入：钉钉导出示例.xlsx'),
    ).toBe(true);
    expect(d.entity('import_batch').require(out.batchId)).toMatchObject({
      status: 'committed',
      fileName: '钉钉导出示例.xlsx',
    });
  });
});

describe('第二次导入同一份表：幂等', () => {
  it('达人、商品、联系人都识别为已有，不会重复创建；有快递单号的寄样单也不重复', () => {
    commit();
    const before = {
      inf: count('influencer'),
      prod: count('product'),
      contact: count('contact'),
      ship: count('sample_shipment'),
      coop: count('cooperation'),
    };
    const cs = READY.configs();
    const out = commitImport(
      d,
      parsed(),
      cs,
      { 达人库: { duplicates: 'skip' } },
      { fileName: '再导入.xlsx', now: NOW },
    );
    const by = Object.fromEntries(out.sheets.map((s) => [s.sheet, s]));
    expect(by['商品库']!.created).toBe(0);
    expect(by['达人库']!.created).toBe(0);
    expect(by['联系人']!.created).toBe(0);
    expect(by['合作跟踪']!.created).toBe(0);
    expect(count('influencer')).toBe(before.inf);
    expect(count('product')).toBe(before.prod);
    expect(count('contact')).toBe(before.contact);
    expect(count('cooperation')).toBe(before.coop);
    // 有单号的 3 行是已有寄样单，没单号的那一行会重复生成（预演里有警告）
    expect(count('sample_shipment')).toBe(before.ship + 1);
  });
});

describe('合并策略：保留旧值 / 覆盖 / 仅填空值', () => {
  const sheetWith = (rows: unknown[][]) => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), '商品');
    return parseFile(Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })), 'p.xlsx');
  };
  const seedProduct = () =>
    d.entity('product').create(d.userActor(), {
      styleNo: 'P1',
      name: '旧名称',
      livePriceCents: 10000,
      mechanism: null,
    });
  const run = (policy: SheetConfig['policy']) => {
    const p = sheetWith([
      ['款号', '商品名称', '直播价', '机制'],
      ['P1', '新名称', 20000, '买一送一'],
    ]);
    const cfg = { ...autoConfig(p.sheets[0]!), policy };
    return commitImport(d, p, [cfg], {}, { fileName: 'p.xlsx', now: NOW });
  };

  it('仅填空值（默认）：旧值非空的不动，空的补上；改价格这类敏感字段不会发生', () => {
    seedProduct();
    const out = run({ default: 'fill' });
    const p = d.entity('product').list()[0]!;
    expect(p).toMatchObject({ name: '旧名称', livePriceCents: 10000, mechanism: '买一送一' });
    expect(out.sheets[0]).toMatchObject({ updated: 1, pendingReview: 0 });
  });

  it('覆盖：用表里的值覆盖；但改金额属于敏感改动，来自导入时进审核队列，不直接写入', () => {
    seedProduct();
    const out = run({ default: 'overwrite' });
    const p = d.entity('product').list()[0]!;
    expect(p.livePriceCents).toBe(10000); // 价格没有被直接改
    expect(p.name).toBe('旧名称'); // 同一个补丁里有敏感字段，整条补丁进了审核
    expect(out.sheets[0]).toMatchObject({ pendingReview: 1 });
    const pending = d.reviewView.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      reason: '修改金额',
      actorType: 'import',
      batchId: out.batchId,
    });
    // 审核通过后才落库
    d.review.approve(pending[0]!.id, d.userId);
    expect(d.entity('product').list()[0]).toMatchObject({
      name: '新名称',
      livePriceCents: 2000000,
    }); // 表里的 20000 是元
  });

  it('按字段指定：名称覆盖、价格保留、机制仅填空', () => {
    seedProduct();
    const out = run({ default: 'fill', fields: { name: 'overwrite', livePriceCents: 'keep' } });
    expect(d.entity('product').list()[0]).toMatchObject({
      name: '新名称',
      livePriceCents: 10000,
      mechanism: '买一送一',
    });
    expect(out.sheets[0]).toMatchObject({ updated: 1, pendingReview: 0 });
  });
});

describe('整批回滚', () => {
  it('撤销整个批次：新建的全部消失，新建的自定义字段也撤销，批次标为已回滚', () => {
    const out = commit();
    expect(count('influencer')).toBeGreaterThan(0);
    const res = rollbackBatch(d, out.batchId);
    expect(res).toMatchObject({ status: 'rolled_back', conflicts: [] });
    expect(res.undone).toBeGreaterThan(30);
    for (const n of [
      'influencer',
      'platform_account',
      'product',
      'product_variant',
      'contact',
      'cooperation',
      'cooperation_product',
      'sample_shipment',
      'sample_shipment_item',
      'influencer_contact',
      'field_def',
    ]) {
      expect(count(n), n).toBe(0);
    }
    expect(d.entity('import_batch').require(out.batchId)).toMatchObject({ status: 'rolled_back' });
    expect(() => rollbackBatch(d, out.batchId)).toThrow(/已经回滚过/);
  });

  it('导入后某条记录又被手动改过：标为冲突并保留，其余照常撤销，批次标为部分回滚', () => {
    const out = commit();
    const a = d
      .entity('influencer')
      .list()
      .find((i) => i.nickname === '林小满')!;
    d.entity('influencer').update(d.userActor(), a.id, { rating: '手动改的评级' });
    const res = rollbackBatch(d, out.batchId);
    expect(res.status).toBe('partial');
    expect(res.conflicts.length).toBeGreaterThanOrEqual(1);
    expect(res.conflicts[0]).toMatchObject({ entity: 'influencer', target: '林小满' });
    expect(d.entity('influencer').get(a.id)).toBeDefined();
    expect(count('product')).toBe(0);
    expect(d.entity('import_batch').require(out.batchId).status).toBe('partial');
  });

  it('回滚也会驳回这个批次里还在待审核的改动', () => {
    d.entity('product').create(d.userActor(), { styleNo: 'P1', name: '旧', livePriceCents: 100 });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ['款号', '名称', '直播价'],
        ['P1', '旧', 999],
      ]),
      'S',
    );
    const p = parseFile(
      Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })),
      'p.xlsx',
    );
    const out = commitImport(
      d,
      p,
      [{ ...autoConfig(p.sheets[0]!), policy: { default: 'overwrite' } }],
      {},
      { fileName: 'p.xlsx', now: NOW },
    );
    expect(d.reviewView.listPending()).toHaveLength(1);
    expect(rollbackBatch(d, out.batchId).rejectedPending).toBe(1);
    expect(d.reviewView.listPending()).toHaveLength(0);
  });
});

describe('自定义字段、原始值、忽略', () => {
  it('新建自定义字段：值按类型转换，字段定义随批次创建；同一列下次导入对应同一个字段', () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ['昵称', '平台', '账号ID', '签约日期', '粉丝画像', '内部备注', '不要的列'],
        ['小Q', '红书', 'q1', '2026/9/1', 8.5, 'VIP', 'x'],
      ]),
      'S',
    );
    const p = parseFile(
      Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })),
      'q.xlsx',
    );
    const cfg = autoConfig(p.sheets[0]!);
    cfg.mapping['3'] = { kind: 'custom', key: 'sign_date', label: '签约日期', type: 'date' };
    cfg.mapping['4'] = { kind: 'custom', key: 'persona', label: '粉丝画像', type: 'number' };
    cfg.mapping['5'] = { kind: 'raw' };
    cfg.mapping['6'] = { kind: 'ignore' };
    const dry = dryRun(d, p, [cfg], {}, NOW).sheets[0]!;
    expect(dry.newCustomFields.map((f) => f.key)).toEqual(['sign_date', 'persona']);
    commitImport(d, p, [cfg], {}, { fileName: 'q.xlsx', now: NOW });
    const q = d.entity('influencer').list()[0]!;
    expect(q.custom).toEqual({
      sign_date: '2026-09-01',
      persona: 8.5,
      import_raw: '内部备注：VIP',
    });
    expect(
      d
        .entity('field_def')
        .list()
        .map((f) => f.key)
        .sort(),
    ).toEqual(['import_raw', 'persona', 'sign_date']);
  });
});

describe('CSV（GBK）', () => {
  it('GBK 编码的 CSV 能识别编码、识别表头、完成预演', () => {
    const p = parseFile(buildSampleCsvGbk(), '达人库.csv');
    expect(p.encoding).toBe('gbk');
    const cfg = autoConfig(p.sheets[0]!);
    expect(cfg).toMatchObject({ target: 'influencer', headerRow: 0 });
    const s = dryRun(d, p, [cfg], {}, NOW).sheets[0]!;
    expect(s.stats.total).toBe(8);
    expect(s.rows[0]!.summary).toBe('林小满 · 小红书 demo_a_001');
  });
});

describe('模板：保存映射，下次按表头自动套用', () => {
  it('列顺序变了、多了一列，也能套用，并提示新增的列', () => {
    const p = parsed();
    const sheet = p.sheets.find((s) => s.name === '达人库')!;
    const a = analyzeSheet(sheet);
    const cfg = autoConfig(sheet);
    cfg.mapping['8'] = { kind: 'raw' }; // 备注 → 存为原始值
    const body = buildTemplate(cfg, a.columns);
    const saved = d
      .entity('mapping_template')
      .create(d.userActor(), { name: '达人库模板', ...body });
    const tpl = (saved as { row: Record<string, unknown> }).row;

    // 新文件：列顺序打乱、多一列"星座"
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        [
          '账号ID',
          '星座',
          '达人昵称',
          '平台',
          '粉丝数',
          '类目',
          '参考佣金',
          '参考报价',
          '身份',
          '备注',
        ],
        ['n1', '狮子座', '新达人', '抖音', '2万', '美妆', '10%', 1000, '博主', '备注内容'],
      ]),
      'S',
    );
    const p2 = parseFile(
      Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })),
      'n.xlsx',
    );
    const cols = buildColumns(p2.sheets[0]!.rows, { row: 0, rows: 1 }).columns;
    const applied = applyTemplate(tpl as never, cols);
    expect(applied.target).toBe('influencer');
    expect(applied.addedColumns).toEqual(['星座']);
    const field = (i: number) => applied.mapping[String(i)];
    expect(field(0)).toEqual({ kind: 'field', field: 'accountId' });
    expect(field(2)).toEqual({ kind: 'field', field: 'nickname' });
    expect(field(9)).toEqual({ kind: 'raw' }); // 模板里"备注"是存为原始值
    expect(field(1)).toBeUndefined(); // 新增的列没有对应字段，交给用户
    const cfg2: SheetConfig = {
      sheet: 'S',
      target: applied.target,
      headerRow: 0,
      headerRows: 1,
      mapping: applied.mapping,
      enumMap: applied.enumMap,
    };
    const out = commitImport(
      d,
      p2,
      [cfg2],
      {},
      { fileName: 'n.xlsx', now: NOW, templateId: tpl.id as string },
    );
    expect(out.sheets[0]).toMatchObject({ created: 1, failed: 0 });
    expect(d.entity('influencer').list()[0]).toMatchObject({
      nickname: '新达人',
      refCommissionPct: 10,
    });
    expect(d.entity('import_batch').require(out.batchId).templateId).toBe(tpl.id);
  });
});

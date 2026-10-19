import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { createApp } from '../app.ts';
import { openDb, runMigrations } from '../db/index.ts';
import { createDomain, type Domain } from '../domain/index.ts';
import { parseFile } from '../import/parse.ts';
import { buildSampleCsvGbk, buildSampleWorkbook } from '../import/sample-data.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-imp-api-'));
const { db, sqlite } = openDb(dir);
runMigrations(db);
let domain: Domain;
let app: ReturnType<typeof createApp>;

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
];
beforeEach(() => {
  for (const t of TABLES) sqlite.exec(`delete from ${t}`);
  domain = createDomain(db);
  app = createApp({ db, sqlite, domain, dataDir: dir });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
async function json(method: string, url: string, body?: unknown) {
  const res = await app.request('/api' + url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as Json };
}
async function upload(buf: Buffer, name: string) {
  const form = new FormData();
  form.append('file', new File([new Uint8Array(buf)], name));
  const res = await app.request('/api/import/upload', { method: 'POST', body: form });
  return { status: res.status, body: (await res.json()) as Json };
}

/** 把上传分析里的建议整理成提交用的配置（相当于用户在向导里点了"下一步"） */
function configsFrom(
  up: Json,
  enumFix: Record<string, Record<string, Record<string, string | null>>> = {},
) {
  return (up.body ?? up).sheets.map((s: Json) => {
    const mapping: Record<string, unknown> = {};
    if (s.template) Object.assign(mapping, s.template.applied.mapping);
    else
      for (const g of s.suggestions)
        if (g.confidence >= 0.7) mapping[String(g.columnIndex)] = g.mapping;
    return {
      sheet: s.name,
      target: s.template?.applied.target ?? s.target,
      headerRow: s.header.row,
      headerRows: s.header.rows,
      mapping,
      enumMap: enumFix[s.name] ?? s.template?.applied.enumMap ?? {},
    };
  });
}
const DECISIONS = { 达人库: { duplicates: 'new' } };
const FIX = { 合作跟踪: { stage: { 火星: '暂缓' } } };

describe('上传与分析', () => {
  it('上传样例：每张表识别出表头、目标和列映射建议，并带前几行预览', async () => {
    const up = await upload(buildSampleWorkbook(), '钉钉导出.xlsx');
    expect(up.status).toBe(200);
    expect(up.body.sessionId).toMatch(/^[0-9A-Z]{26}$/);
    const by = Object.fromEntries(up.body.sheets.map((s: Json) => [s.name, s]));
    expect(Object.keys(by).sort()).toEqual(
      ['商品库', '寄样记录', '联系人', '合作跟踪', '达人库'].sort(),
    );
    expect(by['达人库']).toMatchObject({
      target: 'influencer',
      header: { row: 2, rows: 1 },
      rowCount: 8,
    });
    expect(by['达人库'].preview).toHaveLength(10);
    expect(by['合作跟踪']).toMatchObject({ target: 'cooperation', header: { row: 0, rows: 2 } });
    expect(by['达人库'].columns[0]).toMatchObject({
      name: '达人昵称',
      samples: ['林小满', '陈一诺', '苏晚晚', '顾北北', '许知意'],
    });
    expect(by['达人库'].columns[0].customKey).toMatch(/^c_[0-9a-z]+$/);
    expect(by['达人库'].suggestions[1]).toMatchObject({
      mapping: { kind: 'field', field: 'platform' },
      confidence: 1,
    });
    expect(by['达人库'].template).toBeNull();
  });

  it('GBK 编码的 CSV；不支持的文件和损坏的 xlsx 给出明确提示', async () => {
    const csv = await upload(buildSampleCsvGbk(), '达人库.csv');
    expect(csv.body).toMatchObject({ encoding: 'gbk', sheets: [{ target: 'influencer' }] });
    expect((await upload(Buffer.from('hello'), 'a.pdf')).status).toBe(400);
    const bad = await upload(Buffer.from('这不是 zip'), 'a.xlsx');
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/不是有效的 .xlsx/);
  });

  it('手动改表头行和目标后重新分析；会话过期给出提示', async () => {
    const up = await upload(buildSampleWorkbook(), '钉钉导出.xlsx');
    const re = await json('POST', `/import/${up.body.sessionId}/analyze`, {
      sheet: '达人库',
      headerRow: 3,
      headerRows: 1,
      target: 'product',
    });
    expect(re.body).toMatchObject({ target: 'product', header: { row: 3, rows: 1 } });
    expect(re.body.columns[0].name).toBe('林小满'); // 把数据行当表头了，列名跟着变
    expect(
      (await json('POST', '/import/ABCDEFGHJKMNPQRSTVWXYZ0123/analyze', { sheet: 'x' })).status,
    ).toBe(404);
  });

  it('下载样例文件', async () => {
    const res = await app.request('/api/import/sample.xlsx');
    expect(res.headers.get('content-type')).toContain('spreadsheetml');
    expect(decodeURIComponent(res.headers.get('content-disposition')!)).toContain(
      '钉钉多维表导出示例.xlsx',
    );
    expect(parseFile(Buffer.from(await res.arrayBuffer()), 'x.xlsx').sheets).toHaveLength(5);
  });
});

describe('预演 → 提交 → 回滚', () => {
  it('整个流程：预演不写库；未处理的枚举/重复不能提交；提交后批次可整批回滚', async () => {
    const up = await upload(buildSampleWorkbook(), '钉钉导出.xlsx');
    const id = up.body.sessionId;
    const configs = configsFrom(up);

    const dry = await json('POST', `/import/${id}/dry-run`, { configs, decisions: {} });
    expect(dry.status).toBe(200);
    expect(dry.body.sheets.map((s: Json) => s.sheet)).toEqual([
      '商品库',
      '达人库',
      '联系人',
      '合作跟踪',
      '寄样记录',
    ]); // 按依赖顺序
    const infl = dry.body.sheets.find((s: Json) => s.sheet === '达人库');
    expect(infl.stats).toMatchObject({ new: 5, update: 1, duplicate: 1, error: 1 });
    expect((await json('GET', '/influencers')).body.total).toBe(0);

    const early = await json('POST', `/import/${id}/commit`, { configs, decisions: {} });
    expect(early.status).toBe(400);
    expect(early.body.error).toMatch(/没有对应的系统选项|没有裁决/);

    const ok = await json('POST', `/import/${id}/commit`, {
      configs: configsFrom(up, FIX),
      decisions: DECISIONS,
    });
    expect(ok.status).toBe(200);
    const by = Object.fromEntries(ok.body.sheets.map((s: Json) => [s.sheet, s]));
    expect(by['达人库']).toMatchObject({ created: 6, failed: 1 });
    expect((await json('GET', '/influencers')).body.total).toBe(6);

    const batches = await json('GET', '/import/batches');
    expect(batches.body.rows[0]).toMatchObject({
      id: ok.body.batchId,
      status: 'committed',
      fileName: '钉钉导出.xlsx',
    });
    expect(batches.body.rows[0].stats.sheets).toHaveLength(5);

    const rb = await json('POST', `/import/batches/${ok.body.batchId}/rollback`);
    expect(rb.body).toMatchObject({ status: 'rolled_back', conflicts: [] });
    expect((await json('GET', '/influencers')).body.total).toBe(0);
    expect((await json('GET', '/import/batches')).body.rows[0].status).toBe('rolled_back');
    expect((await json('POST', `/import/batches/${ok.body.batchId}/rollback`)).status).toBe(409);
  });

  it('错误行导出：原表的列 + 错误原因，没有错误时 404', async () => {
    const up = await upload(buildSampleWorkbook(), '钉钉导出.xlsx');
    const id = up.body.sessionId;
    const res = await app.request(`/api/import/${id}/errors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ configs: configsFrom(up, FIX), decisions: DECISIONS }),
    });
    expect(res.status).toBe(200);
    const parsed = parseFile(Buffer.from(await res.arrayBuffer()), 'e.xlsx');
    const sheet = parsed.sheets.find((s) => s.name === '达人库-错误行')!;
    expect(sheet.rows[0]).toEqual(expect.arrayContaining(['原表行号', '达人昵称', '错误原因']));
    expect(sheet.rows[1]![0]).toBe(11);
    expect(sheet.rows[1]![sheet.rows[0]!.length - 1]).toBe('缺少昵称');

    // 没有错误行时：404
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ['款号', '商品名称'],
        ['OK1', '正常商品'],
      ]),
      '商品',
    );
    const clean = await upload(
      Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })),
      'ok.xlsx',
    );
    const none = await app.request(`/api/import/${clean.body.sessionId}/errors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ configs: configsFrom(clean), decisions: {} }),
    });
    expect(none.status).toBe(404);
  });

  it('提交时顺带保存模板；下次上传同样的表自动套用，不用重新映射', async () => {
    const up = await upload(buildSampleWorkbook(), '第一次.xlsx');
    const ok = await json('POST', `/import/${up.body.sessionId}/commit`, {
      configs: configsFrom(up, FIX),
      decisions: DECISIONS,
      saveTemplate: { name: '钉钉导出' },
    });
    expect(ok.body.templateIds).toHaveLength(5);
    const tpls = await json('GET', '/e/mapping_template');
    expect(tpls.body.rows.map((t: Json) => t.name).sort()).toEqual(
      [
        '钉钉导出 · 商品库',
        '钉钉导出 · 寄样记录',
        '钉钉导出 · 联系人',
        '钉钉导出 · 合作跟踪',
        '钉钉导出 · 达人库',
      ].sort(),
    );

    const again = await upload(buildSampleWorkbook(), '第二次.xlsx');
    const infl = again.body.sheets.find((s: Json) => s.name === '达人库');
    expect(infl.template).toMatchObject({
      name: '钉钉导出 · 达人库',
      score: 1,
      added: [],
      missing: [],
    });
    expect(infl.template.applied.mapping['0']).toEqual({ kind: 'field', field: 'nickname' });
    // 枚举映射也一起保存了：第二次不用再处理"火星"
    const coop = again.body.sheets.find((s: Json) => s.name === '合作跟踪');
    expect(coop.template.applied.enumMap).toEqual({ stage: { 火星: '暂缓' } });
    const second = await json('POST', `/import/${again.body.sessionId}/commit`, {
      configs: configsFrom(again),
      decisions: { 达人库: { duplicates: 'skip' } },
    });
    expect(second.status).toBe(200);
    expect(second.body.sheets.find((s: Json) => s.sheet === '达人库')).toMatchObject({
      created: 0,
    });
  });

  it('模板可以改名、删除；列有变化时仍然匹配并提示新增和缺失的列', async () => {
    const up = await upload(buildSampleWorkbook(), 'a.xlsx');
    await json('POST', `/import/${up.body.sessionId}/commit`, {
      configs: configsFrom(up, FIX),
      decisions: DECISIONS,
      saveTemplate: { name: 'T' },
    });
    const list = (await json('GET', '/e/mapping_template')).body.rows;
    const t = list.find((x: Json) => x.name.endsWith('达人库'));
    expect(
      (
        await json('PATCH', `/e/mapping_template/${t.id}`, {
          patch: { name: '我的达人模板' },
          expectedVersion: t.version,
        })
      ).status,
    ).toBe(200);
    expect((await json('GET', '/e/mapping_template')).body.rows.map((x: Json) => x.name)).toContain(
      '我的达人模板',
    );
    expect((await json('DELETE', `/e/mapping_template/${t.id}`)).status).toBe(200);
    expect((await json('GET', '/e/mapping_template')).body.rows).toHaveLength(4);
  });
});

describe('导出', () => {
  async function seed() {
    const up = await upload(buildSampleWorkbook(), 'a.xlsx');
    await json('POST', `/import/${up.body.sessionId}/commit`, {
      configs: configsFrom(up, FIX),
      decisions: DECISIONS,
    });
  }

  it('列表导出：带筛选条件，返回 xlsx 文件', async () => {
    await seed();
    const res = await app.request('/api/export/list/influencer?q=%E6%9E%97%E5%B0%8F%E6%BB%A1');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('spreadsheetml');
    expect(decodeURIComponent(res.headers.get('content-disposition')!)).toMatch(
      /达人-\d{4}-\d{2}-\d{2}\.xlsx/,
    );
    const sheet = parseFile(Buffer.from(await res.arrayBuffer()), 'x.xlsx').sheets[0]!;
    expect(
      sheet.rows
        .slice(1)
        .map((r) => r[0])
        .sort(),
    ).toEqual(['林小满', '林小满.']);
    expect((await app.request('/api/export/list/nope')).status).toBe(404);
  });

  it('全量导出：每类实体一个 sheet', async () => {
    await seed();
    const res = await app.request('/api/export/all');
    const parsed = parseFile(Buffer.from(await res.arrayBuffer()), 'all.xlsx');
    expect(parsed.sheets.map((s) => s.name)).toContain('寄样');
    expect(parsed.sheets.length).toBe(9);
  });
});

describe('字段元数据', () => {
  it('返回每个目标的字段（含必填、枚举选项）和值转换类型，枚举里的跟进状态取设置里的选项', async () => {
    const meta = (await json('GET', '/import/meta')).body;
    expect(Object.keys(meta.targets)).toEqual([
      'influencer',
      'product',
      'contact',
      'cooperation',
      'shipment',
    ]);
    expect(meta.targets.influencer).toMatchObject({ label: '达人', canCustom: true });
    expect(meta.targets.shipment.canCustom).toBe(false);
    const nick = meta.targets.influencer.fields.find((f: Json) => f.key === 'nickname');
    expect(nick).toMatchObject({ label: '昵称', required: true, transform: 'text', enum: null });
    const follow = meta.targets.cooperation.fields.find((f: Json) => f.key === 'followStatus');
    expect(follow.enum).toEqual(['已发邀约', '待回复', '报价中', '选款中', '等档期', '暂无意向']);
    expect(meta.targets.contact.fields.find((f: Json) => f.key === 'phone').sensitive).toBe(true);
    expect(meta.transforms).toMatchObject({
      money: '金额（存为分）',
      followers: '粉丝数',
      date: '日期',
    });
  });
});

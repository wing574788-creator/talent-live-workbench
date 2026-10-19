/**
 * 导出（PRD 6.6）：任一列表导出 .xlsx（含自定义字段），以及全量导出（每类实体一个 sheet，作为离开工作台的退路）。
 * 列名和导入的同义词保持一致，导出的文件可以直接再导入回来。
 */
import * as XLSX from 'xlsx';
import type { Domain } from '../domain/index.ts';
import type { QueryOptions } from '../domain/entity-service.ts';
import type { Row } from '../domain/types.ts';

export interface Sheet {
  name: string;
  headers: string[];
  rows: unknown[][];
}

type Get = (r: Row) => unknown;
interface Col {
  header: string;
  get: Get;
}

const yuan = (cents: unknown) => (typeof cents === 'number' ? cents / 100 : null);
const join = (v: unknown) => (Array.isArray(v) ? v.join('/') : (v ?? null));
const yesNo = (v: unknown) => (v == null ? null : v ? '是' : '否');
const col = (
  header: string,
  key: string,
  fmt: (v: unknown) => unknown = (v) => v ?? null,
): Col => ({ header, get: (r) => fmt(r[key]) });

/** 自定义字段列：用字段的显示名作表头 */
function customCols(d: Domain, entity: string): Col[] {
  return d
    .entity('field_def')
    .findBy('entity', entity)
    .map((f) => ({
      header: String(f.label),
      get: (r: Row) => {
        const v = (r.custom as Record<string, unknown> | null)?.[f.key as string];
        return Array.isArray(v) ? v.join('/') : typeof v === 'boolean' ? yesNo(v) : (v ?? null);
      },
    }));
}

function table(name: string, cols: Col[], rows: Row[]): Sheet {
  return {
    name,
    headers: cols.map((c) => c.header),
    rows: rows.map((r) => cols.map((c) => c.get(r))),
  };
}

/** 列表导出要带上和页面一样的筛选；分页取完 */
function all(d: Domain, entity: string, opts: QueryOptions): Row[] {
  const svc = d.entity(entity);
  const out: Row[] = [];
  for (let offset = 0; ; offset += 500) {
    const { rows, total } = svc.query({ ...opts, limit: 500, offset });
    out.push(...rows);
    if (offset + 500 >= total) break;
  }
  return out;
}

// ───────────── 各实体 ─────────────
function productSheet(d: Domain, opts: QueryOptions = {}): Sheet {
  const variants = d.entity('product_variant');
  const rows: Row[] = [];
  for (const p of all(d, 'product', opts)) {
    const vs = variants.findBy('productId', p.id);
    if (!vs.length) rows.push({ ...p, _color: null, _size: null } as Row);
    else for (const v of vs) rows.push({ ...p, _color: v.color, _size: v.size } as Row);
  }
  return table(
    '商品',
    [
      col('款号', 'styleNo'),
      col('商品名称', 'name'),
      col('状态', 'status'),
      col('日常价', 'dailyPriceCents', yuan),
      col('直播价', 'livePriceCents', yuan),
      col('到手价', 'finalPriceCents', yuan),
      col('双十一价', 'price1111Cents', yuan),
      col('六一八价', 'price618Cents', yuan),
      col('机制赠品', 'mechanism'),
      col('卖点', 'sellingPoints'),
      col('颜色', '_color'),
      col('尺码', '_size'),
      ...customCols(d, 'product'),
    ],
    rows,
  );
}

function influencerSheet(d: Domain, opts: QueryOptions = {}, platform?: string): Sheet {
  const accounts = d.entity('platform_account');
  const rows: Row[] = [];
  for (const i of all(d, 'influencer', opts)) {
    let accs = accounts.findBy('influencerId', i.id);
    if (platform) {
      accs = accs.filter((a) => a.platform === platform);
      if (!accs.length) continue; // 按平台筛选时，没有这个平台账号的达人不导出
    }
    if (!accs.length) rows.push({ ...i } as Row);
    else for (const a of accs) rows.push({ ...i, _a: a } as Row);
  }
  const acc = (key: string, fmt: (v: unknown) => unknown = (v) => v ?? null): Col => ({
    header: '',
    get: (r) => fmt((r._a as Row | undefined)?.[key]),
  });
  const A = (header: string, key: string, fmt?: (v: unknown) => unknown): Col => ({
    ...acc(key, fmt),
    header,
  });
  return table(
    '达人',
    [
      col('达人昵称', 'nickname'),
      col('真实姓名', 'realName'),
      col('类目标签', 'categoryTags', join),
      col('风格标签', 'styleTags', join),
      col('合作方式偏好', 'coopPreference'),
      col('参考佣金（%）', 'refCommissionPct'),
      col('参考报价', 'refQuoteCents', yuan),
      col('评级', 'rating'),
      col('黑名单原因', 'blacklistReason'),
      col('回收问题次数', 'recycleIssueCount'),
      A('平台', 'platform'),
      A('账号ID', 'accountId'),
      A('主页链接', 'profileUrl'),
      A('身份', 'role'),
      A('粉丝数', 'followers'),
      A('场均观看', 'avgViews'),
      A('场均销售额下限', 'avgSalesMinCents', yuan),
      A('场均销售额上限', 'avgSalesMaxCents', yuan),
      A('数据日期', 'statsDate'),
      ...customCols(d, 'influencer'),
    ],
    rows,
  );
}

function contactSheet(d: Domain, opts: QueryOptions = {}): Sheet {
  const links = d.entity('influencer_contact');
  const inf = new Map(
    d
      .entity('influencer')
      .list()
      .map((i) => [i.id, i.nickname as string]),
  );
  const rows = all(d, 'contact', opts).map((c) => {
    const ls = links.findBy('contactId', c.id);
    return {
      ...c,
      _refs: ls
        .map((l) => inf.get(l.influencerId as string))
        .filter(Boolean)
        .join('/'),
      _primary: ls.some((l) => l.isPrimary) ? true : null,
    } as Row;
  });
  return table(
    '联系人',
    [
      col('姓名', 'name'),
      col('类型', 'type'),
      col('所属机构', 'org'),
      col('微信', 'wechat'),
      col('手机', 'phone'),
      col('下次跟进日期', 'nextFollowDate'),
      col('关联达人', '_refs'),
      col('主要对接人', '_primary', yesNo),
      ...customCols(d, 'contact'),
    ],
    rows,
  );
}

function cooperationSheet(d: Domain, opts: QueryOptions = {}): Sheet {
  const inf = new Map(
    d
      .entity('influencer')
      .list()
      .map((i) => [i.id, i]),
  );
  const acc = new Map(
    d
      .entity('platform_account')
      .list()
      .map((a) => [a.id, a]),
  );
  const prod = new Map(
    d
      .entity('product')
      .list()
      .map((p) => [p.id, p]),
  );
  const cps = d.entity('cooperation_product');
  const rows: Row[] = [];
  for (const c of all(d, 'cooperation', opts)) {
    const base = {
      ...c,
      _nick: inf.get(c.influencerId as string)?.nickname,
      _plat: acc.get(c.platformAccountId as string)?.platform,
      _acc: acc.get(c.platformAccountId as string)?.accountId,
    } as Row;
    const items = cps.findBy('cooperationId', c.id);
    if (!items.length) rows.push(base);
    else
      for (const it of items)
        rows.push({
          ...base,
          _style: prod.get(it.productId as string)?.styleNo,
          _pct: it.commissionPct,
          _price: it.livePriceCents,
          _mech: it.mechanism,
        } as Row);
  }
  return table(
    '合作',
    [
      col('达人', '_nick'),
      col('平台', '_plat'),
      col('账号ID', '_acc'),
      col('阶段', 'stage'),
      col('跟进状态', 'followStatus'),
      col('合作模式', 'mode'),
      col('付款状态', 'paymentStatus'),
      col('坑位费', 'slotFeeCents', yuan),
      col('下次跟进日期', 'nextFollowDate'),
      col('开播日期', 'liveDate'),
      col('开播时段', 'liveSlot'),
      col('挂链方式', 'linkMethod'),
      col('流失/放弃原因', 'lostReason'),
      col('合作通道', 'channel'),
      col('报备状态', 'reportStatus'),
      col('合作款号', '_style'),
      col('佣金（%）', '_pct'),
      col('直播价', '_price', yuan),
      col('机制', '_mech'),
      ...customCols(d, 'cooperation'),
    ],
    rows,
  );
}

function shipmentSheet(d: Domain): Sheet {
  const inf = new Map(
    d
      .entity('influencer')
      .list()
      .map((i) => [i.id, i.nickname as string]),
  );
  const items = d.entity('sample_shipment_item');
  const rows: Row[] = [];
  for (const s of d.entity('sample_shipment').list()) {
    for (const it of items.findBy('shipmentId', s.id))
      rows.push({ ...s, _nick: inf.get(s.influencerId as string), _it: it } as Row);
  }
  const I = (header: string, key: string): Col => ({
    header,
    get: (r) => (r._it as Row)[key] ?? null,
  });
  return table(
    '寄样',
    [
      col('达人', '_nick'),
      I('款号', 'styleNo'),
      I('款名', 'productName'),
      I('颜色', 'color'),
      I('尺码', 'size'),
      I('数量', 'qty'),
      col('寄样状态', 'status'),
      col('寄出日期', 'shippedAt'),
      col('签收日期', 'signedAt'),
      col('应寄回日期', 'dueBackDate'),
      col('快递公司', 'carrier'),
      col('快递单号', 'trackingNo'),
      col('收件人', 'recipient'),
      col('手机', 'phone'),
      col('收货地址', 'address'),
    ],
    rows,
  );
}

function returnSheet(d: Domain): Sheet {
  const inf = new Map(
    d
      .entity('influencer')
      .list()
      .map((i) => [i.id, i.nickname as string]),
  );
  const items = d.entity('sample_return_item');
  const rows: Row[] = [];
  for (const r of d.entity('sample_return').list()) {
    for (const it of items.findBy('returnId', r.id))
      rows.push({ ...r, _nick: inf.get(r.influencerId as string), _it: it } as Row);
  }
  const I = (header: string, key: string): Col => ({
    header,
    get: (r) => (r._it as Row)[key] ?? null,
  });
  return table(
    '退样',
    [
      col('达人', '_nick'),
      col('退回日期', 'returnedAt'),
      col('快递公司', 'carrier'),
      col('快递单号', 'trackingNo'),
      I('款号', 'styleNo'),
      I('款名', 'productName'),
      I('颜色', 'color'),
      I('尺码', 'size'),
      I('退回数量', 'qty'),
      I('质检结果', 'qaResult'),
      I('处理结果', 'disposition'),
    ],
    rows,
  );
}

function writeoffSheet(d: Domain): Sheet {
  const inf = new Map(
    d
      .entity('influencer')
      .list()
      .map((i) => [i.id, i.nickname as string]),
  );
  return table(
    '核销',
    [
      { header: '达人', get: (r) => inf.get(r.influencerId as string) ?? null },
      col('款号', 'styleNo'),
      col('款名', 'productName'),
      col('颜色', 'color'),
      col('尺码', 'size'),
      col('数量', 'qty'),
      col('原因', 'reason'),
      col('说明', 'note'),
      col('日期', 'occurredAt'),
    ],
    d.entity('sample_writeoff').list(),
  );
}

function followUpSheet(d: Domain): Sheet {
  const inf = new Map(
    d
      .entity('influencer')
      .list()
      .map((i) => [i.id, i.nickname as string]),
  );
  const con = new Map(
    d
      .entity('contact')
      .list()
      .map((c) => [c.id, c.name as string]),
  );
  return table(
    '跟进记录',
    [
      col('时间', 'occurredAt'),
      col('方式', 'method'),
      { header: '达人', get: (r) => inf.get(r.influencerId as string) ?? null },
      { header: '联系人', get: (r) => con.get(r.contactId as string) ?? null },
      col('内容摘要', 'summary'),
      col('意向', 'intent'),
      col('跟进状态', 'followStatus'),
      col('下一步动作', 'nextAction'),
      col('下次跟进日期', 'nextFollowDate'),
      col('原文出处', 'sourceText'),
    ],
    d.entity('follow_up').list(),
  );
}

function addressSheet(d: Domain): Sheet {
  const inf = new Map(
    d
      .entity('influencer')
      .list()
      .map((i) => [i.id, i.nickname as string]),
  );
  return table(
    '收货地址',
    [
      { header: '达人', get: (r) => inf.get(r.influencerId as string) ?? null },
      col('收件人', 'recipient'),
      col('手机', 'phone'),
      col('地址', 'address'),
      col('默认', 'isDefault', yesNo),
    ],
    d.entity('influencer_address').list(),
  );
}

export type ExportEntity = 'product' | 'influencer' | 'contact' | 'cooperation' | 'shipment';
export const EXPORT_ENTITIES: ExportEntity[] = [
  'product',
  'influencer',
  'contact',
  'cooperation',
  'shipment',
];
export const EXPORT_LABELS: Record<ExportEntity, string> = {
  product: '商品',
  influencer: '达人',
  contact: '联系人',
  cooperation: '合作',
  shipment: '寄样',
};

export function exportList(
  d: Domain,
  entity: ExportEntity,
  opts: QueryOptions & { platform?: string } = {},
): Sheet {
  switch (entity) {
    case 'product':
      return productSheet(d, opts);
    case 'influencer':
      return influencerSheet(d, opts, opts.platform);
    case 'contact':
      return contactSheet(d, opts);
    case 'cooperation':
      return cooperationSheet(d, opts);
    case 'shipment':
      return shipmentSheet(d);
  }
}

/** 全量导出：每类实体一个 sheet。包含个人信息，由用户自己保管。 */
export function exportAll(d: Domain): Sheet[] {
  return [
    productSheet(d),
    influencerSheet(d),
    contactSheet(d),
    cooperationSheet(d),
    followUpSheet(d),
    shipmentSheet(d),
    returnSheet(d),
    writeoffSheet(d),
    addressSheet(d),
  ];
}

export function writeWorkbook(sheets: Sheet[]): Buffer {
  const wb = XLSX.utils.book_new();
  const used = new Set<string>();
  for (const s of sheets) {
    const ws = XLSX.utils.aoa_to_sheet([s.headers, ...s.rows]);
    ws['!cols'] = s.headers.map((h) => ({ wch: Math.max(10, Math.min(30, h.length * 2 + 4)) }));
    let name = s.name.replace(/[\\/?*[\]:]/g, '_').slice(0, 31) || 'Sheet';
    for (let i = 2; used.has(name); i++) name = `${s.name.slice(0, 28)}(${i})`;
    used.add(name);
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
  type SQLiteTableWithColumns,
} from 'drizzle-orm/sqlite-core';

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

/** 公共字段（CLAUDE.md 铁律 9）：每张表都展开。每次调用返回新的列构造器。 */
export const common = () => ({
  id: text('id').primaryKey(),
  createdAt: text('created_at').notNull().default(now),
  updatedAt: text('updated_at').notNull().default(now),
  createdBy: text('created_by'),
  ownerId: text('owner_id'),
  version: integer('version').notNull().default(1),
  deletedAt: text('deleted_at'),
});

const json = <T>(name: string) => text(name, { mode: 'json' }).$type<T>();
const bool = (name: string) => integer(name, { mode: 'boolean' });

// ───────────────────────── 用户 ─────────────────────────
export const users = sqliteTable('users', {
  ...common(),
  name: text('name').notNull(),
  isDefault: bool('is_default').notNull().default(false),
});

// ───────────────────────── 商品 ─────────────────────────
export const products = sqliteTable(
  'products',
  {
    ...common(),
    styleNo: text('style_no').notNull(),
    name: text('name').notNull(),
    status: text('status').notNull().default('在售'),
    dailyPriceCents: integer('daily_price_cents'),
    livePriceCents: integer('live_price_cents'),
    finalPriceCents: integer('final_price_cents'),
    price1111Cents: integer('price_1111_cents'),
    price618Cents: integer('price_618_cents'),
    mechanism: text('mechanism'),
    sizeChart: json<Record<string, string | number>[]>('size_chart'),
    sizeChartImageId: text('size_chart_image_id'),
    sellingPoints: text('selling_points'),
    custom: json<Record<string, unknown>>('custom'),
  },
  (t) => [
    uniqueIndex('products_style_no_uq')
      .on(t.styleNo)
      .where(sql`${t.deletedAt} is null`),
  ],
);

export const productVariants = sqliteTable(
  'product_variants',
  {
    ...common(),
    productId: text('product_id').notNull(),
    color: text('color').notNull(),
    size: text('size').notNull(),
  },
  (t) => [
    uniqueIndex('product_variants_uq')
      .on(t.productId, t.color, t.size)
      .where(sql`${t.deletedAt} is null`),
  ],
);

export const productPlatformLinks = sqliteTable('product_platform_links', {
  ...common(),
  productId: text('product_id').notNull(),
  platform: text('platform').notNull(),
  platformProductId: text('platform_product_id'),
  url: text('url'),
});

export const productImages = sqliteTable('product_images', {
  ...common(),
  productId: text('product_id').notNull(),
  attachmentId: text('attachment_id').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
});

// ───────────────────────── 达人 ─────────────────────────
export const influencers = sqliteTable('influencers', {
  ...common(),
  nickname: text('nickname').notNull(),
  realName: text('real_name'),
  categoryTags: json<string[]>('category_tags'),
  styleTags: json<string[]>('style_tags'),
  coopPreference: text('coop_preference'),
  refCommissionPct: real('ref_commission_pct'),
  refQuoteCents: integer('ref_quote_cents'),
  refUpdatedAt: text('ref_updated_at'),
  refSource: text('ref_source'),
  rating: text('rating'),
  blacklistReason: text('blacklist_reason'),
  recycleIssueCount: integer('recycle_issue_count').notNull().default(0),
  custom: json<Record<string, unknown>>('custom'),
});

export const influencerAddresses = sqliteTable('influencer_addresses', {
  ...common(),
  influencerId: text('influencer_id').notNull(),
  recipient: text('recipient').notNull(),
  phone: text('phone'),
  address: text('address').notNull(),
  isDefault: bool('is_default').notNull().default(false),
});

/** 查重强唯一键：平台 + 账号 ID（未软删除的记录之间唯一）。 */
export const platformAccounts = sqliteTable(
  'platform_accounts',
  {
    ...common(),
    influencerId: text('influencer_id').notNull(),
    platform: text('platform').notNull(),
    accountId: text('account_id').notNull(),
    profileUrl: text('profile_url'),
    role: text('role'),
    followers: integer('followers'),
    avgViews: integer('avg_views'),
    avgSalesMinCents: integer('avg_sales_min_cents'),
    avgSalesMaxCents: integer('avg_sales_max_cents'),
    statsDate: text('stats_date'),
  },
  (t) => [
    uniqueIndex('platform_accounts_uq')
      .on(t.platform, t.accountId)
      .where(sql`${t.deletedAt} is null`),
    index('platform_accounts_influencer_idx').on(t.influencerId),
  ],
);

// ───────────────────────── 联系人 ─────────────────────────
export const contacts = sqliteTable('contacts', {
  ...common(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  org: text('org'),
  wechat: text('wechat'),
  phone: text('phone'),
  nextFollowDate: text('next_follow_date'),
  custom: json<Record<string, unknown>>('custom'),
});

export const influencerContacts = sqliteTable(
  'influencer_contacts',
  {
    ...common(),
    influencerId: text('influencer_id').notNull(),
    contactId: text('contact_id').notNull(),
    isPrimary: bool('is_primary').notNull().default(false),
  },
  (t) => [
    uniqueIndex('influencer_contacts_uq')
      .on(t.influencerId, t.contactId)
      .where(sql`${t.deletedAt} is null`),
  ],
);

// ───────────────────────── 合作 ─────────────────────────
export const cooperations = sqliteTable(
  'cooperations',
  {
    ...common(),
    influencerId: text('influencer_id').notNull(),
    platformAccountId: text('platform_account_id').notNull(),
    contactId: text('contact_id'),
    mode: text('mode').notNull().default('纯佣'),
    stage: text('stage').notNull().default('待建联'),
    followStatus: text('follow_status'),
    paymentStatus: text('payment_status'),
    slotFeeCents: integer('slot_fee_cents'),
    liveDate: text('live_date'),
    liveSlot: text('live_slot'),
    linkMethod: text('link_method'),
    nextFollowDate: text('next_follow_date'),
    lostReason: text('lost_reason'),
    channel: text('channel'),
    reportStatus: text('report_status'),
    custom: json<Record<string, unknown>>('custom'),
  },
  (t) => [
    index('cooperations_influencer_idx').on(t.influencerId),
    index('cooperations_stage_idx').on(t.stage),
    index('cooperations_next_follow_idx').on(t.nextFollowDate),
  ],
);

/** 佣金只设在合作商品上（商品本身没有默认佣金）。 */
export const cooperationProducts = sqliteTable('cooperation_products', {
  ...common(),
  cooperationId: text('cooperation_id').notNull(),
  productId: text('product_id').notNull(),
  commissionPct: real('commission_pct'),
  livePriceCents: integer('live_price_cents'),
  mechanism: text('mechanism'),
});

export const followUps = sqliteTable(
  'follow_ups',
  {
    ...common(),
    occurredAt: text('occurred_at').notNull(),
    method: text('method').notNull(),
    cooperationId: text('cooperation_id'),
    influencerId: text('influencer_id'),
    contactId: text('contact_id'),
    summary: text('summary').notNull(),
    intent: text('intent'),
    followStatus: text('follow_status'),
    nextAction: text('next_action'),
    nextFollowDate: text('next_follow_date'),
    sourceText: text('source_text'),
    sourceAttachmentId: text('source_attachment_id'),
  },
  (t) => [
    index('follow_ups_coop_idx').on(t.cooperationId),
    index('follow_ups_influencer_idx').on(t.influencerId),
  ],
);

// ───────────────────────── 样品台账（按达人记账） ─────────────────────────
export const sampleShipments = sqliteTable(
  'sample_shipments',
  {
    ...common(),
    influencerId: text('influencer_id').notNull(),
    cooperationId: text('cooperation_id'),
    recipient: text('recipient'),
    phone: text('phone'),
    address: text('address'),
    status: text('status').notNull().default('待寄样'),
    shippedAt: text('shipped_at'),
    carrier: text('carrier'),
    trackingNo: text('tracking_no'),
    signedAt: text('signed_at'),
    dueBackDate: text('due_back_date'),
  },
  (t) => [index('sample_shipments_influencer_idx').on(t.influencerId)],
);

export const sampleShipmentItems = sqliteTable(
  'sample_shipment_items',
  {
    ...common(),
    shipmentId: text('shipment_id').notNull(),
    productId: text('product_id'),
    styleNo: text('style_no').notNull(),
    productName: text('product_name').notNull(),
    color: text('color').notNull(),
    size: text('size').notNull(),
    qty: integer('qty').notNull(),
    unitValueCents: integer('unit_value_cents'),
  },
  (t) => [index('sample_shipment_items_shipment_idx').on(t.shipmentId)],
);

export const sampleReturns = sqliteTable(
  'sample_returns',
  {
    ...common(),
    influencerId: text('influencer_id').notNull(),
    returnedAt: text('returned_at').notNull(),
    carrier: text('carrier'),
    trackingNo: text('tracking_no'),
  },
  (t) => [index('sample_returns_influencer_idx').on(t.influencerId)],
);

export const sampleReturnItems = sqliteTable(
  'sample_return_items',
  {
    ...common(),
    returnId: text('return_id').notNull(),
    styleNo: text('style_no').notNull(),
    productName: text('product_name').notNull(),
    color: text('color').notNull(),
    size: text('size').notNull(),
    qty: integer('qty').notNull(),
    qaResult: text('qa_result'),
    photoAttachmentIds: json<string[]>('photo_attachment_ids'),
    disposition: text('disposition'),
  },
  (t) => [index('sample_return_items_return_idx').on(t.returnId)],
);

/** 核销：报损、买断、赠送等不再追回的在外样品。 */
export const sampleWriteoffs = sqliteTable(
  'sample_writeoffs',
  {
    ...common(),
    influencerId: text('influencer_id').notNull(),
    styleNo: text('style_no').notNull(),
    productName: text('product_name').notNull(),
    color: text('color').notNull(),
    size: text('size').notNull(),
    qty: integer('qty').notNull(),
    reason: text('reason').notNull(),
    note: text('note'),
    occurredAt: text('occurred_at').notNull(),
  },
  (t) => [index('sample_writeoffs_influencer_idx').on(t.influencerId)],
);

export const attachments = sqliteTable('attachments', {
  ...common(),
  kind: text('kind').notNull(),
  path: text('path').notNull(),
  originalName: text('original_name'),
  mime: text('mime'),
  sizeBytes: integer('size_bytes'),
  ownerType: text('owner_type'),
  ownerId: text('owner_id'),
});

// ───────────────────────── 自定义字段 / 导入 / 外发 / 摘要 ─────────────────────────
export const fieldDefs = sqliteTable(
  'field_defs',
  {
    ...common(),
    entity: text('entity').notNull(),
    key: text('key').notNull(),
    label: text('label').notNull(),
    type: text('type').notNull(),
    options: json<string[]>('options'),
    sensitive: bool('sensitive').notNull().default(false),
    allowOutbound: bool('allow_outbound').notNull().default(false),
    indexed: bool('indexed').notNull().default(false),
  },
  (t) => [
    uniqueIndex('field_defs_uq')
      .on(t.entity, t.key)
      .where(sql`${t.deletedAt} is null`),
  ],
);

export const importBatches = sqliteTable('import_batches', {
  ...common(),
  fileName: text('file_name'),
  entity: text('entity'),
  templateId: text('template_id'),
  status: text('status').notNull().default('committed'),
  stats: json<Record<string, number>>('stats'),
  rolledBackAt: text('rolled_back_at'),
});

export const mappingTemplates = sqliteTable('mapping_templates', {
  ...common(),
  name: text('name').notNull(),
  entity: text('entity').notNull(),
  headerSignature: json<string[]>('header_signature').notNull(),
  mapping: json<Record<string, unknown>>('mapping').notNull(),
  transforms: json<Record<string, unknown>>('transforms'),
  enumMap: json<Record<string, unknown>>('enum_map'),
});

export const outboundPolicies = sqliteTable('outbound_policies', {
  ...common(),
  scope: text('scope').notNull(),
  key: text('key').notNull(),
  value: json<Record<string, unknown>>('value').notNull(),
});

export const outboundLogs = sqliteTable('outbound_logs', {
  ...common(),
  model: text('model').notNull(),
  module: text('module'),
  /** 实际发出的内容（已脱敏） */
  payload: text('payload').notNull(),
});

/** AI 会话索引（PRD 9.3）：对话本身按 Pi 的 JSONL 存在数据目录里，这里只存索引和侧栏回显用的记录 */
export const aiSessions = sqliteTable('ai_sessions', {
  ...common(),
  title: text('title').notNull(),
  /** Pi 会话文件，相对数据目录 */
  file: text('file'),
  /** 侧栏回显用的消息（文字和卡片） */
  transcript: json<unknown[]>('transcript')
    .notNull()
    .default(sql`'[]'`),
});

export const summaryCache = sqliteTable(
  'summary_cache',
  {
    ...common(),
    day: text('day').notNull(),
    kind: text('kind').notNull().default('home'),
    content: text('content').notNull(),
  },
  (t) => [uniqueIndex('summary_cache_uq').on(t.day, t.kind)],
);

// ───────────────────────── 变更日志与审核队列 ─────────────────────────
export const changeLog = sqliteTable(
  'change_log',
  {
    ...common(),
    entity: text('entity').notNull(),
    entityId: text('entity_id').notNull(),
    action: text('action').notNull(), // create | update | delete
    before: json<Record<string, unknown>>('before'),
    after: json<Record<string, unknown>>('after'),
    actorType: text('actor_type').notNull(), // user | agent | import
    actorId: text('actor_id'),
    batchId: text('batch_id'),
    /** 经审核通过的改动：审核人 */
    approvedBy: text('approved_by'),
    /** 这条日志是对哪条日志的撤销 */
    undoOf: text('undo_of'),
    /** 被撤销的时间 */
    revertedAt: text('reverted_at'),
    source: text('source'),
  },
  (t) => [
    index('change_log_entity_idx').on(t.entity, t.entityId),
    index('change_log_batch_idx').on(t.batchId),
  ],
);

export const pendingChanges = sqliteTable(
  'pending_changes',
  {
    ...common(),
    entity: text('entity').notNull(),
    entityId: text('entity_id').notNull(),
    action: text('action').notNull(), // update | delete
    /** 要应用的字段补丁（delete 时为空） */
    patch: json<Record<string, unknown>>('patch'),
    /** 提出改动时的整行快照，用于前后对比 */
    before: json<Record<string, unknown>>('before'),
    baseVersion: integer('base_version').notNull(),
    reason: text('reason').notNull(),
    /** 需要审核的人留意的警告（如佣金异常），审核卡片上标黄 */
    warnings: json<string[]>('warnings'),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    batchId: text('batch_id'),
    source: text('source'),
    status: text('status').notNull().default('pending'),
    reviewedAt: text('reviewed_at'),
    reviewedBy: text('reviewed_by'),
  },
  (t) => [index('pending_changes_status_idx').on(t.status)],
);

export type AnyTable = SQLiteTableWithColumns<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** 列表保存视图：筛选、排序、列显隐。 */
export const savedViews = sqliteTable(
  'saved_views',
  {
    ...common(),
    entity: text('entity').notNull(),
    name: text('name').notNull(),
    config: json<Record<string, unknown>>('config').notNull(),
  },
  (t) => [
    uniqueIndex('saved_views_uq')
      .on(t.entity, t.name)
      .where(sql`${t.deletedAt} is null`),
  ],
);

/** 可在设置里增删的枚举选项（如洽谈中的跟进状态）。 */
export const enumOptions = sqliteTable(
  'enum_options',
  {
    ...common(),
    group: text('group').notNull(),
    value: text('value').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [
    uniqueIndex('enum_options_uq')
      .on(t.group, t.value)
      .where(sql`${t.deletedAt} is null`),
  ],
);

/** 键值设置（预警阈值等）。 */
export const appSettings = sqliteTable(
  'app_settings',
  {
    ...common(),
    key: text('key').notNull(),
    value: json<unknown>('value').notNull(),
  },
  (t) => [
    uniqueIndex('app_settings_uq')
      .on(t.key)
      .where(sql`${t.deletedAt} is null`),
  ],
);

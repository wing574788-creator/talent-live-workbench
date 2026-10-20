import { z } from 'zod';
import * as E from './enums.ts';

/** 金额：整数"分"（铁律 6）。 */
export const cents = z.number().int().nonnegative();
/** 日期：YYYY-MM-DD */
export const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD');
export const isoTime = z.string().datetime({ offset: true });
const custom = z.record(z.unknown()).optional();
const id = z.string().min(1);
const text = z.string().trim();
const reqText = text.min(1);

/** 创建 schema 一律 strict：多余字段直接报错，避免拼写错误被悄悄丢掉。 */
const obj = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const productSchema = obj({
  styleNo: reqText,
  name: reqText,
  status: z.enum(E.PRODUCT_STATUSES).default('在售'),
  dailyPriceCents: cents.nullish(),
  livePriceCents: cents.nullish(),
  finalPriceCents: cents.nullish(),
  price1111Cents: cents.nullish(),
  price618Cents: cents.nullish(),
  mechanism: text.nullish(),
  sizeChart: z.array(z.record(z.union([z.string(), z.number()]))).nullish(),
  sizeChartImageId: id.nullish(),
  sellingPoints: text.nullish(),
  custom,
});

export const productVariantSchema = obj({
  productId: id,
  color: reqText,
  size: reqText,
});

export const productPlatformLinkSchema = obj({
  productId: id,
  platform: z.enum(E.PLATFORMS),
  platformProductId: text.nullish(),
  url: text.nullish(),
});

export const productImageSchema = obj({
  productId: id,
  attachmentId: id,
  sortOrder: z.number().int().default(0),
});

export const influencerSchema = obj({
  nickname: reqText,
  realName: text.nullish(),
  categoryTags: z.array(z.string()).default([]),
  styleTags: z.array(z.string()).default([]),
  coopPreference: text.nullish(),
  refCommissionPct: z.number().min(0).max(100).nullish(),
  refQuoteCents: cents.nullish(),
  refUpdatedAt: isoTime.nullish(),
  refSource: text.nullish(),
  rating: text.nullish(),
  blacklistReason: text.nullish(),
  recycleIssueCount: z.number().int().nonnegative().default(0),
  custom,
});

export const influencerAddressSchema = obj({
  influencerId: id,
  recipient: reqText,
  phone: text.nullish(),
  address: reqText,
  isDefault: z.boolean().default(false),
});

export const platformAccountSchema = obj({
  influencerId: id,
  platform: z.enum(E.PLATFORMS),
  accountId: reqText,
  profileUrl: text.nullish(),
  role: z.enum(E.ACCOUNT_ROLES).nullish(),
  followers: z.number().int().nonnegative().nullish(),
  avgViews: z.number().int().nonnegative().nullish(),
  avgSalesMinCents: cents.nullish(),
  avgSalesMaxCents: cents.nullish(),
  statsDate: dateStr.nullish(),
});

export const contactSchema = obj({
  name: reqText,
  type: z.enum(E.CONTACT_TYPES),
  org: text.nullish(),
  wechat: text.nullish(),
  phone: text.nullish(),
  nextFollowDate: dateStr.nullish(),
  custom,
});

export const influencerContactSchema = obj({
  influencerId: id,
  contactId: id,
  isPrimary: z.boolean().default(false),
});

export const cooperationSchema = obj({
  influencerId: id,
  platformAccountId: id,
  contactId: id.nullish(),
  mode: z.enum(E.COOP_MODES).default('纯佣'),
  stage: z.enum(E.COOP_STAGES).default('待建联'),
  followStatus: text.nullish(),
  paymentStatus: z.enum(E.PAYMENT_STATUSES).nullish(),
  slotFeeCents: cents.nullish(),
  liveDate: dateStr.nullish(),
  liveSlot: text.nullish(),
  linkMethod: text.nullish(),
  nextFollowDate: dateStr.nullish(),
  lostReason: text.nullish(),
  channel: text.nullish(),
  reportStatus: text.nullish(),
  custom,
});

export const cooperationProductSchema = obj({
  cooperationId: id,
  productId: id,
  commissionPct: z.number().min(0).max(100).nullish(),
  livePriceCents: cents.nullish(),
  mechanism: text.nullish(),
});

export const followUpSchema = obj({
  occurredAt: isoTime,
  method: z.enum(E.FOLLOW_METHODS),
  cooperationId: id.nullish(),
  influencerId: id.nullish(),
  contactId: id.nullish(),
  summary: reqText,
  intent: z.enum(E.INTENTS).nullish(),
  followStatus: text.nullish(),
  nextAction: text.nullish(),
  nextFollowDate: dateStr.nullish(),
  sourceText: text.nullish(),
  sourceAttachmentId: id.nullish(),
});

export const sampleShipmentSchema = obj({
  influencerId: id,
  cooperationId: id.nullish(),
  recipient: text.nullish(),
  phone: text.nullish(),
  address: text.nullish(),
  status: z.enum(E.SHIPMENT_STATUSES).default('待寄样'),
  shippedAt: dateStr.nullish(),
  carrier: text.nullish(),
  trackingNo: text.nullish(),
  signedAt: dateStr.nullish(),
  dueBackDate: dateStr.nullish(),
});

const sampleLine = {
  styleNo: reqText,
  productName: reqText,
  color: reqText,
  size: reqText,
};

export const sampleShipmentItemSchema = obj({
  shipmentId: id,
  productId: id.nullish(),
  ...sampleLine,
  qty: z.number().int().positive(),
  unitValueCents: cents.nullish(),
});

export const sampleReturnSchema = obj({
  influencerId: id,
  returnedAt: dateStr,
  carrier: text.nullish(),
  trackingNo: text.nullish(),
});

export const sampleReturnItemSchema = obj({
  returnId: id,
  ...sampleLine,
  qty: z.number().int().positive(),
  qaResult: z.enum(E.QA_RESULTS).nullish(),
  photoAttachmentIds: z.array(id).default([]),
  disposition: z.enum(E.DISPOSITIONS).nullish(),
});

export const sampleWriteoffSchema = obj({
  influencerId: id,
  ...sampleLine,
  qty: z.number().int().positive(),
  reason: z.enum(E.WRITEOFF_REASONS),
  note: text.nullish(),
  occurredAt: dateStr,
});

export const attachmentSchema = obj({
  kind: z.enum(['product_image', 'size_chart', 'qa_photo', 'screenshot', 'other']),
  path: reqText,
  originalName: text.nullish(),
  mime: text.nullish(),
  sizeBytes: z.number().int().nonnegative().nullish(),
  ownerType: text.nullish(),
  ownerId: id.nullish(),
});

export const fieldDefSchema = obj({
  entity: z.enum(E.CUSTOM_FIELD_ENTITIES),
  key: z.string().regex(/^[a-z][a-z0-9_]*$/, '字段键只能用小写字母、数字、下划线'),
  label: reqText,
  type: z.enum(E.CUSTOM_FIELD_TYPES),
  options: z.array(z.string()).nullish(),
  sensitive: z.boolean().default(false),
  allowOutbound: z.boolean().default(false),
  indexed: z.boolean().default(false),
});

export const mappingTemplateSchema = obj({
  name: reqText,
  entity: z.string().min(1),
  headerSignature: z.array(z.string()),
  mapping: z.record(z.unknown()),
  transforms: z.record(z.unknown()).default({}),
  enumMap: z.record(z.unknown()).default({}),
});

export const outboundPolicySchema = obj({
  scope: z.enum(['global', 'module', 'field']),
  key: reqText,
  value: z.record(z.unknown()),
});

export type ProductInput = z.input<typeof productSchema>;
export type CooperationInput = z.input<typeof cooperationSchema>;

export const savedViewSchema = obj({
  entity: z.enum(['product', 'influencer', 'contact', 'cooperation']),
  name: reqText,
  config: z.record(z.unknown()),
});

export const enumOptionSchema = obj({
  group: z.enum(['follow_status']),
  value: reqText,
  sortOrder: z.number().int().default(0),
});

export const settingSchema = obj({
  key: reqText,
  value: z.unknown(),
});

/** 设置项默认值 */
export const SETTING_DEFAULTS = {
  /** 连续 N 次跟进状态都是"待回复"时提醒转暂缓/流失（PRD 5.3） */
  replyStallCount: 3,
  /**
   * 应寄回日期默认值（PRD 5.5 写明"N / M"但未给数值，这里先取 3 和 7，待用户确认）：
   * 有开播日 → 开播日 + N 天；未排期 → 签收日 + M 天。
   */
  returnAfterLiveDays: 3,
  returnAfterSignDays: 7,
  /** 待寄样超过这么多天未寄出，首页寄样预警（PRD 5.1） */
  shipOverdueDays: 3,
  /** 已签收超过这么多天还没开播，首页寄样预警（PRD 5.1，默认 14，待用户确认） */
  signedNotLiveDays: 14,
} as const;

export const importBatchSchema = obj({
  fileName: text.nullish(),
  entity: text.nullish(),
  templateId: id.nullish(),
  status: z.enum(['running', 'committed', 'rolled_back', 'partial']).default('running'),
  stats: z.record(z.unknown()).nullish(),
  rolledBackAt: isoTime.nullish(),
});

export const outboundLogSchema = obj({
  model: reqText,
  module: text.nullish(),
  payload: z.string(),
});

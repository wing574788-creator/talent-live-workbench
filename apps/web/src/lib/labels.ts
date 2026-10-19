import { fmtDate, fmtMoney } from './format.ts';

export const ENTITY_LABEL: Record<string, string> = {
  product: '商品',
  product_variant: '商品规格',
  product_platform_link: '平台链接',
  product_image: '商品图片',
  influencer: '达人',
  influencer_address: '收货地址',
  platform_account: '平台账号',
  contact: '联系人',
  influencer_contact: '达人-联系人关联',
  cooperation: '合作',
  cooperation_product: '合作商品',
  follow_up: '跟进记录',
  sample_shipment: '寄样单',
  sample_shipment_item: '寄样明细',
  sample_return: '退样单',
  sample_return_item: '退样明细',
  sample_writeoff: '核销',
  attachment: '附件',
  field_def: '自定义字段',
  enum_option: '选项',
  setting: '设置',
  saved_view: '保存的视图',
  mapping_template: '导入模板',
  outbound_policy: '外发规则',
};

/** 字段中文名；没列出的字段显示原始键名 */
export const FIELD_LABELS: Record<string, string> = {
  styleNo: '款号',
  name: '名称',
  nickname: '昵称',
  realName: '真实姓名',
  status: '状态',
  stage: '阶段',
  mode: '合作模式',
  followStatus: '跟进状态',
  nextFollowDate: '下次跟进日期',
  nextAction: '下一步动作',
  liveDate: '开播日期',
  liveSlot: '开播时段',
  linkMethod: '挂链方式',
  lostReason: '流失/放弃原因',
  channel: '合作通道',
  reportStatus: '报备状态',
  paymentStatus: '付款状态',
  slotFeeCents: '坑位费',
  commissionPct: '佣金（%）',
  refCommissionPct: '参考佣金（%）',
  refQuoteCents: '参考报价',
  livePriceCents: '直播价',
  dailyPriceCents: '日常价',
  finalPriceCents: '到手价',
  price1111Cents: '双十一价',
  price618Cents: '六一八价',
  unitValueCents: '单件价值',
  mechanism: '机制赠品',
  sellingPoints: '卖点',
  rating: '评级',
  blacklistReason: '黑名单原因',
  recycleIssueCount: '回收问题次数',
  categoryTags: '类目标签',
  styleTags: '风格标签',
  coopPreference: '合作方式偏好',
  type: '类型',
  org: '所属机构',
  wechat: '微信',
  phone: '手机',
  address: '地址',
  recipient: '收件人',
  platform: '平台',
  accountId: '账号 ID',
  followers: '粉丝数',
  color: '颜色',
  size: '尺码',
  qty: '数量',
  summary: '内容摘要',
  intent: '意向',
  method: '方式',
  shippedAt: '寄出日期',
  signedAt: '签收日期',
  dueBackDate: '应寄回日期',
  carrier: '快递公司',
  trackingNo: '快递单号',
  returnedAt: '退回日期',
  qaResult: '质检结果',
  disposition: '处理结果',
  reason: '原因',
  occurredAt: '时间',
  isPrimary: '主要对接人',
  isDefault: '默认',
  influencerId: '达人',
  cooperationId: '合作',
  productId: '商品',
  contactId: '联系人',
  platformAccountId: '平台账号',
  custom: '自定义字段',
};

export const ACTOR_LABEL: Record<string, string> = { user: '手动', agent: 'AI', import: '导入' };

export const fieldLabel = (f: string) => FIELD_LABELS[f] ?? f;

/** 值的可读形式：金额按"分"换算成元，日期加星期，数组、布尔、空值 */
export function fmtValue(field: string, v: unknown): string {
  if (v == null || v === '') return '空';
  if (field.endsWith('Cents') && typeof v === 'number') return fmtMoney(v);
  if (/Date$|At$/.test(field) && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v))
    return fmtDate(v);
  if (typeof v === 'boolean') return v ? '是' : '否';
  if (Array.isArray(v)) return v.length ? v.join('、') : '空';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

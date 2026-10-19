/** 业务枚举（PRD 4、5 节）。可在设置里增删的选项（如跟进状态）运行时以数据库为准，这里是默认值。 */

export const PLATFORMS = ['小红书', '抖音', '视频号'] as const;
export const ACCOUNT_ROLES = ['博主', '买手', '两者'] as const;
export const CONTACT_TYPES = ['达人本人', 'MCN', '经纪人', '私人商务'] as const;
export const PRODUCT_STATUSES = ['在售', '下架'] as const;

export const COOP_MODES = ['纯佣', '坑位费+佣金', '专场'] as const;
/** 主线阶段，顺序即看板列顺序 */
export const COOP_MAIN_STAGES = [
  '待建联',
  '洽谈中',
  '已确认',
  '待寄样',
  '已排期',
  '已开播',
  '待退样',
  '待复盘',
  '完成',
] as const;
export const COOP_SIDE_STAGES = ['暂缓', '流失', '放弃'] as const;
export const COOP_STAGES = [...COOP_MAIN_STAGES, ...COOP_SIDE_STAGES] as const;
export const PAYMENT_STATUSES = ['未付', '已付', '已退'] as const;
export const DEFAULT_FOLLOW_STATUSES = [
  '已发邀约',
  '待回复',
  '报价中',
  '选款中',
  '等档期',
  '暂无意向',
] as const;

export const FOLLOW_METHODS = ['微信', '电话', '平台消息', '其他'] as const;
export const INTENTS = ['高', '中', '低'] as const;

export const SHIPMENT_STATUSES = ['待寄样', '已寄出', '已签收'] as const;
export const QA_RESULTS = ['完好', '污渍', '破损', '缺配件', '吊牌缺失', '其他'] as const;
export const DISPOSITIONS = ['重新入库', '报损', '待沟通', '索赔'] as const;
export const WRITEOFF_REASONS = ['报损', '达人买断', '赠送', '其他'] as const;

export const ACTOR_TYPES = ['user', 'agent', 'import'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const CUSTOM_FIELD_ENTITIES = ['product', 'influencer', 'contact', 'cooperation'] as const;
export const CUSTOM_FIELD_TYPES = [
  'text',
  'number',
  'date',
  'select',
  'multiselect',
  'bool',
] as const;

export const PENDING_STATUSES = ['pending', 'approved', 'rejected', 'conflict'] as const;
export type PendingStatus = (typeof PENDING_STATUSES)[number];

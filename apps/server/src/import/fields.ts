import {
  ACCOUNT_ROLES,
  CONTACT_TYPES,
  COOP_MODES,
  COOP_STAGES,
  PAYMENT_STATUSES,
  PRODUCT_STATUSES,
  SHIPMENT_STATUSES,
} from '@workbench/shared';
import type { FieldDef, TargetKey } from './types.ts';

const f = (
  key: string,
  label: string,
  transform: FieldDef['transform'],
  aliases: string[],
  extra: Partial<FieldDef> = {},
): FieldDef => ({ key, label, transform, aliases, ...extra });

const INFLUENCER: FieldDef[] = [
  f(
    'nickname',
    '昵称',
    'text',
    [
      '昵称',
      '达人昵称',
      '达人',
      '博主',
      '名称',
      '达人名称',
      '账号名称',
      '名字',
      '达人名',
      '博主昵称',
    ],
    { required: true },
  ),
  f('realName', '真实姓名', 'text', ['真实姓名', '姓名', '本名'], { sensitive: true }),
  f('categoryTags', '类目标签', 'multi', ['类目', '类目标签', '品类', '类别', '擅长类目']),
  f('styleTags', '风格标签', 'multi', ['风格', '风格标签', '标签']),
  f('coopPreference', '合作方式偏好', 'text', ['合作方式', '合作偏好', '合作方式偏好']),
  f('refCommissionPct', '参考佣金（%）', 'percent', [
    '佣金',
    '参考佣金',
    '佣金比例',
    '佣金率',
    '分佣',
    '点位',
  ]),
  f('refQuoteCents', '参考报价', 'money', ['报价', '参考报价', '坑位费', '价格']),
  f('rating', '评级', 'text', ['评级', '等级', '评分', '分级']),
  f('blacklistReason', '黑名单原因', 'text', ['黑名单原因', '拉黑原因', '黑名单']),
  f('platform', '平台', 'platform', ['平台', '渠道', '所属平台', '主平台', '主要平台'], {
    hint: '小红书/抖音/视频号；"红书""XHS"等写法会自动归一',
  }),
  f(
    'accountId',
    '账号 ID',
    'text',
    [
      '账号id',
      '账号',
      '平台账号',
      '小红书号',
      '抖音号',
      '主页id',
      'id',
      '账号号',
      '博主id',
      '达人id',
      '小红书id',
    ],
    { hint: '平台 + 账号 ID 是查重的唯一键' },
  ),
  f('profileUrl', '主页链接', 'text', ['主页', '主页链接', '链接', '主页地址', '主页url']),
  f('role', '身份', 'text', ['身份', '角色', '账号身份', '博主类型'], { enum: ACCOUNT_ROLES }),
  f('followers', '粉丝数', 'followers', ['粉丝', '粉丝数', '粉丝量', '粉丝数量']),
  f('avgViews', '场均观看', 'followers', ['场均观看', '平均观看', '场观', '场均观看人数']),
  f('avgSalesMinCents', '场均销售额下限', 'money', [
    '场均销售额下限',
    '销售额下限',
    '最低销售额',
    '场均销售额(最低)',
  ]),
  f('avgSalesMaxCents', '场均销售额上限', 'money', [
    '场均销售额上限',
    '销售额上限',
    '最高销售额',
    '场均销售额(最高)',
  ]),
  f('statsDate', '数据日期', 'date', [
    '数据日期',
    '统计日期',
    '数据更新日期',
    '更新日期',
    '数据时间',
  ]),
];

const PRODUCT: FieldDef[] = [
  f(
    'styleNo',
    '款号',
    'text',
    ['款号', '货号', '款式编号', '编号', '商品编号', 'sku', '款式号', '商品款号'],
    { required: true },
  ),
  f(
    'name',
    '名称',
    'text',
    ['商品名称', '名称', '款名', '品名', '商品', '标题', '商品名', '商品标题'],
    { required: true },
  ),
  f('status', '状态', 'text', ['状态', '上架状态', '商品状态', '在售状态'], {
    enum: PRODUCT_STATUSES,
  }),
  f('dailyPriceCents', '日常价', 'money', ['日常价', '吊牌价', '原价', '售价', '零售价', '日销价']),
  f('livePriceCents', '直播价', 'money', ['直播价', '直播间价', '直播间价格']),
  f('finalPriceCents', '到手价', 'money', ['到手价', '券后价', '活动价', '到手价格']),
  f('price1111Cents', '双十一价', 'money', ['双十一价', '双11价', '1111价', '双十一价格']),
  f('price618Cents', '六一八价', 'money', ['六一八价', '618价', '618', '618价格']),
  f('mechanism', '机制赠品', 'text', ['机制', '赠品', '机制赠品', '福利', '直播机制']),
  f('sellingPoints', '卖点', 'text', ['卖点', '商品卖点', '亮点', '核心卖点']),
  f('color', '颜色', 'text', ['颜色', '色号', '色', '款色'], { hint: '和尺码一起会生成商品规格' }),
  f('size', '尺码', 'text', ['尺码', '码数', '规格尺码', '尺寸', '码']),
];

const CONTACT: FieldDef[] = [
  f('name', '姓名', 'text', ['联系人', '姓名', '名称', '经纪人', '对接人', '联系人姓名', '商务'], {
    required: true,
  }),
  f('type', '类型', 'text', ['类型', '联系人类型', '角色', '身份', '对接人类型'], {
    enum: CONTACT_TYPES,
    required: true,
  }),
  f('org', '所属机构', 'text', ['机构', '所属机构', 'mcn', '公司', '机构名称', '所属mcn']),
  f('wechat', '微信', 'text', ['微信', '微信号', 'wx', 'vx'], { sensitive: true }),
  f('phone', '手机', 'text', ['手机', '手机号', '电话', '联系电话', '手机号码'], {
    sensitive: true,
  }),
  f('nextFollowDate', '下次跟进日期', 'date', ['下次跟进', '下次跟进日期', '下次联系']),
  f(
    'influencerRef',
    '关联达人',
    'multi',
    ['关联达人', '达人', '所属达人', '管理达人', '对接达人'],
    { hint: '填达人昵称或账号 ID，可多个' },
  ),
  f('isPrimary', '主要对接人', 'bool', ['主要对接人', '是否主要', '主对接人']),
];

const COOPERATION: FieldDef[] = [
  f(
    'influencerNickname',
    '达人',
    'text',
    ['达人', '达人昵称', '博主', '昵称', '合作达人', '博主昵称'],
    { required: true, hint: '昵称或账号 ID，必须是已有达人' },
  ),
  f('platform', '平台', 'platform', ['平台', '渠道']),
  f('accountId', '账号 ID', 'text', ['账号id', '账号', '平台账号']),
  f('stage', '阶段', 'text', ['阶段', '合作阶段', '状态', '进度', '合作状态'], {
    enum: COOP_STAGES,
  }),
  f('followStatus', '跟进状态', 'text', ['跟进状态', '洽谈状态', '沟通状态'], {
    enum: 'follow_status',
  }),
  f('mode', '合作模式', 'text', ['合作模式', '合作方式', '模式'], { enum: COOP_MODES }),
  f('paymentStatus', '付款状态', 'text', ['付款状态', '支付状态', '款项状态'], {
    enum: PAYMENT_STATUSES,
  }),
  f('slotFeeCents', '坑位费', 'money', ['坑位费', '保底', '保底费用']),
  f('nextFollowDate', '下次跟进日期', 'date', ['下次跟进', '下次跟进日期', '下次联系', '下次沟通']),
  f('liveDate', '开播日期', 'date', [
    '开播日期',
    '开播日',
    '直播日期',
    '直播时间',
    '档期',
    '开播时间',
  ]),
  f('liveSlot', '开播时段', 'text', ['开播时段', '直播时段', '时段']),
  f('linkMethod', '挂链方式', 'text', ['挂链方式', '挂链', '链接方式']),
  f('lostReason', '流失/放弃原因', 'text', ['流失原因', '放弃原因', '原因', '流失/放弃原因']),
  f('channel', '合作通道', 'text', ['合作通道', '通道']),
  f('reportStatus', '报备状态', 'text', ['报备状态', '报备']),
  f('productStyleNo', '合作款号', 'text', ['款号', '商品款号', '货号', '合作款号', '合作商品'], {
    hint: '填已有商品的款号，会同时建立合作商品',
  }),
  f('commissionPct', '佣金（%）', 'percent', ['佣金', '佣金比例', '佣金率', '分佣', '点位']),
  f('productLivePriceCents', '直播价', 'money', ['直播价']),
  f('productMechanism', '机制', 'text', ['机制', '赠品', '直播机制']),
];

const SHIPMENT: FieldDef[] = [
  f('influencerNickname', '达人', 'text', ['达人', '达人昵称', '博主', '昵称', '收样达人'], {
    required: true,
    hint: '昵称或账号 ID，必须是已有达人',
  }),
  f('platform', '平台', 'platform', ['平台', '渠道']),
  f('accountId', '账号 ID', 'text', ['账号id', '账号', '平台账号']),
  f('styleNo', '款号', 'text', ['款号', '货号', '商品款号', '样衣款号'], { required: true }),
  f('productName', '款名', 'text', ['款名', '商品名称', '名称', '品名', '样衣名称']),
  f('color', '颜色', 'text', ['颜色', '色号', '色'], { required: true }),
  f('size', '尺码', 'text', ['尺码', '码数', '尺寸', '码'], { required: true }),
  f('qty', '数量', 'integer', ['数量', '件数', '个数', '寄样数量'], { required: true }),
  f('status', '寄样状态', 'text', ['状态', '寄样状态', '发货状态'], { enum: SHIPMENT_STATUSES }),
  f('shippedAt', '寄出日期', 'date', ['寄出日期', '发货日期', '寄样日期', '寄出时间', '发货时间']),
  f('signedAt', '签收日期', 'date', ['签收日期', '签收时间']),
  f('dueBackDate', '应寄回日期', 'date', [
    '应寄回日期',
    '应退日期',
    '归还日期',
    '应归还日期',
    '寄回日期',
  ]),
  f('carrier', '快递公司', 'text', ['快递', '快递公司', '物流', '物流公司']),
  f('trackingNo', '快递单号', 'text', ['快递单号', '单号', '运单号', '物流单号']),
  f('recipient', '收件人', 'text', ['收件人', '收货人'], { sensitive: true }),
  f('phone', '手机', 'text', ['手机', '手机号', '收件人电话', '联系电话'], { sensitive: true }),
  f('address', '收货地址', 'text', ['地址', '收货地址', '收件地址'], { sensitive: true }),
];

export const TARGET_FIELDS: Record<TargetKey, FieldDef[]> = {
  influencer: INFLUENCER,
  product: PRODUCT,
  contact: CONTACT,
  cooperation: COOPERATION,
  shipment: SHIPMENT,
};

export const TARGET_LABELS: Record<TargetKey, string> = {
  influencer: '达人',
  product: '商品',
  contact: '联系人',
  cooperation: '合作',
  shipment: '寄样',
};

/** 支持新建自定义字段的目标（寄样没有自定义字段） */
export const CUSTOM_TARGETS: TargetKey[] = ['influencer', 'product', 'contact', 'cooperation'];

export function fieldOf(target: TargetKey, key: string): FieldDef | undefined {
  return TARGET_FIELDS[target].find((x) => x.key === key);
}

/** 枚举值的常见写法 → 系统选项（按字段键）。精确等于选项的不需要写在这里。 */
export const ENUM_SYNONYMS: Record<string, Record<string, string[]>> = {
  stage: {
    待建联: ['未建联', '待联系', '未联系', '新线索', '线索'],
    洽谈中: ['沟通中', '在聊', '洽谈', '谈判中', '跟进中', '谈合作', '聊着'],
    已确认: ['确认', '已确定', '已敲定', '谈妥', '已谈妥', '确定合作'],
    待寄样: ['待发样', '准备寄样', '要寄样', '待送样'],
    已排期: ['已定档', '已约档', '排期中', '已排档', '已约'],
    已开播: ['已直播', '开播', '已播', '直播完成'],
    待退样: ['待回寄', '待退回', '待回收', '待寄回'],
    待复盘: ['待总结', '复盘中', '待分析'],
    完成: ['已完成', '结束', '已结束', '完结'],
    暂缓: ['搁置', '暂停', '延后', '待定'],
    流失: ['丢失', '谈崩', '失败', '黄了'],
    放弃: ['不合作', '放弃合作', '已放弃'],
  },
  followStatus: {
    已发邀约: ['已邀约', '已发邀请', '邀约已发'],
    待回复: ['等回复', '未回复', '等待回复'],
    报价中: ['谈价中', '议价中', '报价'],
    选款中: ['选品中', '选款'],
    等档期: ['等排期', '待档期', '等待档期'],
    暂无意向: ['没意向', '无意向', '暂无合作意向'],
  },
  mode: {
    纯佣: ['纯佣金', '佣金', '纯分佣'],
    '坑位费+佣金': ['坑位+佣金', '坑位费加佣金', '保底+佣金', '坑位费+分佣', '保底加佣金'],
    专场: ['专场直播', '品牌专场'],
  },
  paymentStatus: {
    未付: ['未支付', '未付款', '待付款', '待支付'],
    已付: ['已支付', '已付款', '已结清'],
    已退: ['已退款', '退款'],
  },
  status: {
    在售: ['上架', '销售中', '在架', '已上架', '在售中'],
    下架: ['停售', '已下架', '下线', '已停售'],
    待寄样: ['待发货', '待发样', '未寄出', '未发货'],
    已寄出: ['已发货', '已寄', '寄出', '在途', '运输中', '已发样'],
    已签收: ['签收', '已收货', '已送达', '已收到', '已收样'],
  },
  type: {
    达人本人: ['本人', '达人', '博主本人'],
    MCN: ['机构', 'mcn机构', '公会'],
    经纪人: ['经纪', '经理', '艺人经纪', '达人经纪人'],
    私人商务: ['商务', '私商', '个人商务', '私人'],
  },
  role: {
    博主: ['达人', '主播', '创作者'],
    买手: ['买手达人', '选品官'],
    两者: ['博主+买手', '博主/买手', '都是', '两者都是', '博主兼买手'],
  },
};

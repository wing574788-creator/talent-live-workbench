/**
 * 外发过滤（PRD 8.2，CLAUDE.md 铁律 5）：
 * 发给模型的一切内容在本地先脱敏。手机号、微信号、地址、真实姓名这四类是**固定规则，无法关闭**；
 * 全局 / 按模块 / 按字段的外发配置只能在此之上收紧。每次外发写外发日志（脱敏后的实际内容）。
 */
import { DomainError } from '../domain/errors.ts';
import type { Domain } from '../domain/index.ts';
import type { Row } from '../domain/types.ts';
import type { Region } from './config.ts';

// ───────────── 外发配置 ─────────────
export const OUTBOUND_MODULES = {
  product: {
    label: '商品',
    fields: {
      styleNo: '款号',
      name: '名称',
      status: '状态',
      dailyPriceCents: '日常价',
      livePriceCents: '直播价',
      finalPriceCents: '到手价',
      price1111Cents: '双十一价',
      price618Cents: '六一八价',
      mechanism: '机制赠品',
      sellingPoints: '卖点',
    },
  },
  influencer: {
    label: '达人',
    fields: {
      nickname: '昵称',
      categoryTags: '类目标签',
      styleTags: '风格标签',
      coopPreference: '合作方式偏好',
      refCommissionPct: '参考佣金',
      refQuoteCents: '参考报价',
      rating: '评级',
      blacklistReason: '黑名单原因',
      recycleIssueCount: '回收问题次数',
      platform: '平台',
      accountId: '账号 ID',
      followers: '粉丝数',
      avgViews: '场均观看',
    },
  },
  contact: {
    label: '联系人',
    fields: { name: '姓名', type: '类型', org: '所属机构', nextFollowDate: '下次跟进日期' },
  },
  cooperation: {
    label: '合作',
    fields: {
      stage: '阶段',
      followStatus: '跟进状态',
      mode: '合作模式',
      paymentStatus: '付款状态',
      slotFeeCents: '坑位费',
      nextFollowDate: '下次跟进日期',
      liveDate: '开播日期',
      liveSlot: '开播时段',
      linkMethod: '挂链方式',
      lostReason: '流失/放弃原因',
      commissionPct: '佣金',
      livePriceCents: '直播价',
    },
  },
  follow_up: {
    label: '跟进',
    fields: {
      occurredAt: '时间',
      method: '方式',
      summary: '内容摘要',
      intent: '意向',
      followStatus: '跟进状态',
      nextAction: '下一步动作',
      nextFollowDate: '下次跟进日期',
    },
  },
  shipment: {
    label: '寄样',
    fields: {
      styleNo: '款号',
      productName: '款名',
      color: '颜色',
      size: '尺码',
      qty: '数量',
      status: '状态',
      shippedAt: '寄出日期',
      signedAt: '签收日期',
      dueBackDate: '应寄回日期',
      carrier: '快递公司',
      trackingNo: '快递单号',
    },
  },
} as const;
export type OutboundModule = keyof typeof OUTBOUND_MODULES;
export const MODULE_KEYS = Object.keys(OUTBOUND_MODULES) as OutboundModule[];

/** 固定脱敏、不会提供给模型的字段（仅用于配置页展示"固定脱敏"） */
export const FIXED_MASKED: Record<OutboundModule, string[]> = {
  product: [],
  influencer: ['真实姓名', '收货地址'],
  contact: ['微信', '手机'],
  cooperation: [],
  follow_up: [],
  shipment: ['收件人', '手机', '收货地址'],
};

export type FieldMode = 'allow' | 'deny' | 'mask';
export interface OutboundPolicy {
  /** 全局：是否允许发给云端模型。关闭后只能用本地模型 */
  allowOutbound: boolean;
  /** 全局：限定模型所在区域 */
  region: 'any' | 'domestic' | 'local';
  modules: Partial<Record<OutboundModule, 'allow' | 'deny'>>;
  /** `模块.字段` → 模式；自定义字段用 `模块.custom.键` */
  fields: Record<string, FieldMode>;
}

export const defaultPolicy = (): OutboundPolicy => ({
  allowOutbound: true,
  region: 'any',
  modules: {},
  fields: {},
});

const POLICY_KEY = 'policy';

export function loadPolicy(d: Domain): OutboundPolicy {
  const row = d.entity('outbound_policy').findBy('key', POLICY_KEY)[0];
  return { ...defaultPolicy(), ...((row?.value as Partial<OutboundPolicy>) ?? {}) };
}

export function savePolicy(d: Domain, policy: OutboundPolicy) {
  const svc = d.entity('outbound_policy');
  const row = svc.findBy('key', POLICY_KEY)[0];
  const value = policy as unknown as Record<string, unknown>;
  return row
    ? svc.update(d.userActor(), row.id, { value })
    : svc.create(d.userActor(), { scope: 'global', key: POLICY_KEY, value });
}

/** 这个提供方的区域是否被外发配置允许 */
export function assertRegionAllowed(policy: OutboundPolicy, region: Region, label: string) {
  if (region === 'local') return;
  if (!policy.allowOutbound)
    throw new DomainError(
      'outbound_blocked',
      `外发设置里关闭了"允许外发"，「${label}」是云端模型，不能使用。请改用本地模型，或在「AI 助手 → 外发规则」里开启外发。`,
    );
  if (policy.region === 'local')
    throw new DomainError(
      'outbound_blocked',
      `外发设置限定"仅允许本地模型"，「${label}」不是本地模型。`,
    );
  if (policy.region === 'domestic' && region !== 'domestic')
    throw new DomainError(
      'outbound_blocked',
      `外发设置限定"仅允许境内模型"，「${label}」不在境内。`,
    );
}

// ───────────── 固定脱敏规则 ─────────────
export type Kind = 'phone' | 'wechat' | 'address' | 'name' | 'idcard' | 'email';
const TOKEN: Record<Kind, string> = {
  phone: '手机号',
  wechat: '微信号',
  address: '地址',
  name: '姓名',
  idcard: '证件号',
  email: '邮箱',
};

const PHONE = /(?<![\d])(?:\+?86[ -]?)?1[3-9]\d[ -]?\d{4}[ -]?\d{4}(?![\d])/g;
const IDCARD =
  /(?<![\d])[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![\d])/g;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const WECHAT =
  /((?:微信号?|薇信|V信|v信|vx|VX|wx|WX|weixin)\s*[:：=]?\s*)([a-zA-Z][-_a-zA-Z0-9]{5,19})/g;
const NAME_LABELED = /((?:真实姓名|本名|收件人|收货人|联系人姓名)\s*[:：=]\s*)([一-龥·]{2,5})/g;
const ADDRESS =
  /(?:[一-龥]{2,}(?:省|自治区|特别行政区))?[一-龥]{2,}?(?:市|自治州|盟)[一-龥]{1,}?(?:区|县|市|旗)[一-龥\d\-—#（）()·]{1,}?(?:路|街|道|巷|弄|号|村|镇|乡|园|苑|庭|城|大厦|中心|广场|栋|幢|楼|室|座|单元)(?:\s*[\d一二三四五六七八九十百]+\s*(?:号|栋|幢|楼|室|座|单元|层|弄|巷)|[一-龥\w\-#（）()·])*/g;

export interface SensitiveDict {
  phone: string[];
  wechat: string[];
  address: string[];
  name: string[];
}

/** 从数据库收集所有已知的敏感值（真实姓名、手机、微信、收货地址、收件人，以及标为敏感的自定义字段） */
export function buildDict(d: Domain): SensitiveDict {
  const dict: SensitiveDict = { phone: [], wechat: [], address: [], name: [] };
  const add = (k: keyof SensitiveDict, v: unknown, min: number) => {
    const s = String(v ?? '').trim();
    if (s.length >= min) dict[k].push(s);
  };
  for (const i of d.entity('influencer').list()) add('name', i.realName, 2);
  for (const c of d.entity('contact').list()) {
    add('wechat', c.wechat, 5);
    add('phone', c.phone, 5);
  }
  for (const a of d.entity('influencer_address').list()) {
    add('name', a.recipient, 2);
    add('phone', a.phone, 5);
    add('address', a.address, 6);
  }
  for (const s of d.entity('sample_shipment').list()) {
    add('name', s.recipient, 2);
    add('phone', s.phone, 5);
    add('address', s.address, 6);
  }
  // 标为敏感的自定义字段：它的值一律按姓名类处理
  const sensitiveKeys = new Map<string, Set<string>>();
  for (const f of d.entity('field_def').list()) {
    if (f.sensitive)
      sensitiveKeys.set(
        f.entity as string,
        (sensitiveKeys.get(f.entity as string) ?? new Set()).add(f.key as string),
      );
  }
  for (const [entity, keys] of sensitiveKeys) {
    for (const r of d.entity(entity).list()) {
      const c = (r.custom ?? {}) as Record<string, unknown>;
      for (const k of keys) if (typeof c[k] === 'string') add('name', c[k], 2);
    }
  }
  for (const k of Object.keys(dict) as (keyof SensitiveDict)[])
    dict[k] = [...new Set(dict[k])].sort((a, b) => b.length - a.length);
  return dict;
}

export interface Redactions {
  phone: number;
  wechat: number;
  address: number;
  name: number;
  idcard: number;
  email: number;
}
export const noRedactions = (): Redactions => ({
  phone: 0,
  wechat: 0,
  address: 0,
  name: 0,
  idcard: 0,
  email: 0,
});

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 脱敏一段文字：先精确替换库里已知的值，再用规则兜底。同一个值每次得到同一个占位符。 */
export function sanitizeText(
  text: string,
  dict: SensitiveDict,
  hits: Redactions = noRedactions(),
): string {
  const seen = new Map<string, string>();
  const counters: Partial<Record<Kind, number>> = {};
  const token = (kind: Kind, value: string) => {
    const key = `${kind}:${value}`;
    let t = seen.get(key);
    if (!t) {
      counters[kind] = (counters[kind] ?? 0) + 1;
      t = `[${TOKEN[kind]}${counters[kind]}]`;
      seen.set(key, t);
    }
    hits[kind]++;
    return t;
  };

  let out = text;
  // 1) 库里已知的值（最长的先替换，避免短值破坏长值）
  const known: [Kind, string[]][] = [
    ['address', dict.address],
    ['phone', dict.phone],
    ['wechat', dict.wechat],
    ['name', dict.name],
  ];
  for (const [kind, values] of known) {
    for (const v of values) {
      if (!out.includes(v)) continue;
      out = out.replace(new RegExp(esc(v), 'g'), () => token(kind, v));
    }
  }
  // 2) 规则兜底：库里没有的手机号、微信号、地址、证件号、邮箱、带标签的姓名
  out = out.replace(IDCARD, (m) => token('idcard', m));
  out = out.replace(PHONE, (m) => token('phone', m.replace(/\D/g, '')));
  out = out.replace(EMAIL, (m) => token('email', m));
  out = out.replace(WECHAT, (_, label: string, id: string) => label + token('wechat', id));
  out = out.replace(NAME_LABELED, (_, label: string, n: string) => label + token('name', n));
  out = out.replace(ADDRESS, (m) => token('address', m));
  return out;
}

/** 递归脱敏一个请求载荷里所有字符串；图片一律拒绝外发（截图只能以本地 OCR 出来的文字发送）。 */
export function sanitizePayload<T>(
  payload: T,
  dict: SensitiveDict,
  hits: Redactions = noRedactions(),
): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      if (/^data:image\//i.test(v))
        throw new DomainError(
          'outbound_blocked',
          '不允许把图片发给模型：截图要先在本地识别成文字，再按外发规则发送文字。',
        );
      return sanitizeText(v, dict, hits);
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (o.type === 'image' || o.type === 'image_url' || o.type === 'input_image') {
        throw new DomainError(
          'outbound_blocked',
          '不允许把图片发给模型：截图要先在本地识别成文字，再按外发规则发送文字。',
        );
      }
      return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return walk(payload) as T;
}

// ───────────── 工具返回结果的按配置过滤 ─────────────
export class OutboundGuard {
  readonly dict: SensitiveDict;
  readonly hits = noRedactions();

  constructor(
    private readonly d: Domain,
    readonly policy: OutboundPolicy = loadPolicy(d),
  ) {
    this.dict = buildDict(d);
  }

  sanitize(text: string) {
    return sanitizeText(text, this.dict, this.hits);
  }

  moduleAllowed(m: OutboundModule) {
    return this.policy.modules[m] !== 'deny';
  }

  /** 工具调用前检查：这个模块的数据按外发规则能不能给模型看 */
  assertModule(m: OutboundModule) {
    if (!this.moduleAllowed(m)) {
      throw new DomainError(
        'outbound_blocked',
        `按外发设置，「${OUTBOUND_MODULES[m].label}」的数据不允许发给模型，所以我查不了这部分内容。`,
      );
    }
  }

  /**
   * 把一行记录整理成给模型看的样子：只留目录里列出的字段，被配置禁止的去掉，要求脱敏的打码，
   * 自定义字段默认不外发（除非字段定义里允许）。固定脱敏的字段（手机、微信、地址、真实姓名）压根不在目录里。
   */
  project(
    m: OutboundModule,
    row: Row | Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const out: Record<string, unknown> = { id: (row as Row).id };
    const merged = { ...row, ...extra } as Record<string, unknown>;
    for (const key of Object.keys(OUTBOUND_MODULES[m].fields)) {
      if (!(key in merged) || merged[key] == null) continue;
      const mode = this.policy.fields[`${m}.${key}`] ?? 'allow';
      if (mode === 'deny') continue;
      out[key] =
        mode === 'mask'
          ? '[已隐藏]'
          : typeof merged[key] === 'string'
            ? this.sanitize(merged[key] as string)
            : merged[key];
    }
    const custom = (row as Row).custom as Record<string, unknown> | null | undefined;
    if (custom && typeof custom === 'object') {
      const defs = this.d.entity('field_def').findBy('entity', m);
      for (const def of defs) {
        if (def.sensitive || custom[def.key as string] == null) continue;
        const mode =
          this.policy.fields[`${m}.custom.${def.key}`] ?? (def.allowOutbound ? 'allow' : 'deny');
        if (mode === 'deny') continue;
        const v = custom[def.key as string];
        out[`自定义:${def.label}`] =
          mode === 'mask' ? '[已隐藏]' : typeof v === 'string' ? this.sanitize(v) : v;
      }
    }
    return out;
  }

  /** 写外发日志：模型、用途、实际发出的内容（已脱敏）。 */
  log(model: string, purpose: string, payload: unknown) {
    this.d.entity('outbound_log').create(this.d.userActor({ source: '外发日志' }), {
      model,
      module: purpose,
      payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
    });
  }
}

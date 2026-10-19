import { eq } from 'drizzle-orm';
import * as S from '@workbench/shared';
import type { Db } from '../db/index.ts';
import * as T from '../db/schema.ts';
import { EntityService, newId, type EntityConfig, type ServiceRegistry } from './entity-service.ts';
import { CooperationAutomation } from './automation.ts';
import { SampleService } from './sample-service.ts';
import { CooperationService, FollowUpService } from './cooperation-service.ts';
import { DomainError } from './errors.ts';
import { InfluencerService } from './influencer-service.ts';
import { ReadModels } from './read-models.ts';
import { HomeService } from './home-service.ts';
import { ReviewService } from './review-service.ts';
import { ReviewView } from './review-view.ts';
import { SettingsService } from './settings-service.ts';
import type { Actor, Row, SensitivityRule } from './types.ts';

const touches =
  (fields: string[], label: string): SensitivityRule =>
  ({ patch }) =>
    patch && fields.some((f) => f in patch) ? label : undefined;

/** 多条规则取第一条命中的原因 */
const anyOf =
  (...rules: SensitivityRule[]): SensitivityRule =>
  (ctx) => {
    for (const r of rules) {
      const reason = r(ctx);
      if (reason) return reason;
    }
    return undefined;
  };

const completedCoop: SensitivityRule = ({ before }) =>
  before.stage === '完成' ? '修改已完成的合作' : undefined;

interface HookCtx {
  registry: ServiceRegistry;
  settings: SettingsService;
  automation: CooperationAutomation;
}

const FOLLOW_CHANGE = '洽谈中的合作必须有下次跟进日期';

const makeConfigs = ({ registry, settings, automation }: HookCtx): EntityConfig[] => [
  {
    name: 'product',
    table: T.products,
    schema: S.productSchema,
    sensitivity: touches(
      ['dailyPriceCents', 'livePriceCents', 'finalPriceCents', 'price1111Cents', 'price618Cents'],
      '修改金额',
    ),
    searchFields: ['styleNo', 'name'],
    filterFields: ['status'],
    sortFields: ['styleNo', 'name', 'status', 'livePriceCents', 'createdAt', 'updatedAt'],
  },
  { name: 'product_variant', table: T.productVariants, schema: S.productVariantSchema },
  {
    name: 'product_platform_link',
    table: T.productPlatformLinks,
    schema: S.productPlatformLinkSchema,
  },
  { name: 'product_image', table: T.productImages, schema: S.productImageSchema },
  {
    name: 'influencer',
    table: T.influencers,
    schema: S.influencerSchema,
    sensitivity: touches(['refCommissionPct', 'refQuoteCents'], '修改金额或佣金'),
    searchFields: ['nickname'],
    filterFields: ['rating'],
    sortFields: ['nickname', 'rating', 'recycleIssueCount', 'createdAt', 'updatedAt'],
  },
  { name: 'influencer_address', table: T.influencerAddresses, schema: S.influencerAddressSchema },
  { name: 'platform_account', table: T.platformAccounts, schema: S.platformAccountSchema },
  {
    name: 'contact',
    table: T.contacts,
    schema: S.contactSchema,
    searchFields: ['name', 'org'],
    filterFields: ['type'],
    sortFields: ['name', 'type', 'org', 'createdAt', 'updatedAt'],
  },
  {
    name: 'saved_view',
    table: T.savedViews,
    schema: S.savedViewSchema,
    filterFields: ['entity'],
  },
  { name: 'influencer_contact', table: T.influencerContacts, schema: S.influencerContactSchema },
  {
    name: 'cooperation',
    table: T.cooperations,
    schema: S.cooperationSchema,
    sensitivity: anyOf(touches(['slotFeeCents'], '修改金额'), completedCoop),
    filterFields: ['stage', 'followStatus', 'influencerId', 'mode'],
    sortFields: ['stage', 'nextFollowDate', 'liveDate', 'updatedAt', 'createdAt'],
    validateState: (next, before) => {
      const stage = next.stage as string;
      if ((stage === '流失' || stage === '放弃') && !String(next.lostReason ?? '').trim()) {
        throw new DomainError('validation', '进入流失或放弃必须填写原因');
      }
      if (stage === '洽谈中' && !next.nextFollowDate)
        throw new DomainError('validation', FOLLOW_CHANGE);
      const fs = next.followStatus as string | null | undefined;
      if (fs && fs !== before?.followStatus && !settings.followStatuses().includes(fs)) {
        throw new DomainError('validation', `跟进状态「${fs}」不在可选项里（可在设置里增加）`);
      }
      if (
        !before ||
        next.platformAccountId !== before.platformAccountId ||
        next.influencerId !== before.influencerId
      ) {
        const acc = registry.get('platform_account').require(next.platformAccountId as string);
        registry.get('influencer').require(next.influencerId as string);
        if (acc.influencerId !== next.influencerId) {
          throw new DomainError('validation', '平台账号不属于所选达人');
        }
      }
    },
  },
  {
    name: 'cooperation_product',
    table: T.cooperationProducts,
    schema: S.cooperationProductSchema,
    sensitivity: touches(['commissionPct', 'livePriceCents'], '修改金额或佣金'),
  },
  {
    name: 'follow_up',
    table: T.followUps,
    schema: S.followUpSchema,
    validateState: (next) => {
      const fs = next.followStatus as string | null | undefined;
      if (fs && !settings.followStatuses().includes(fs)) {
        throw new DomainError('validation', `跟进状态「${fs}」不在可选项里（可在设置里增加）`);
      }
    },
  },
  { name: 'enum_option', table: T.enumOptions, schema: S.enumOptionSchema },
  { name: 'setting', table: T.appSettings, schema: S.settingSchema },
  {
    name: 'sample_shipment',
    table: T.sampleShipments,
    schema: S.sampleShipmentSchema,
    afterWrite: ({ action, before, after, undo }) => {
      if (undo) return automation.onSamplesChanged(after.influencerId as string);
      const counted = (r: Row | null) => !!r && ['已寄出', '已签收'].includes(r.status as string);
      if (action === 'create') automation.onShipmentCreated(after.cooperationId as string | null);
      if (counted(after) && !counted(before))
        automation.onShipped(after.cooperationId as string | null);
      automation.onSamplesChanged(after.influencerId as string);
    },
  },
  {
    name: 'sample_shipment_item',
    table: T.sampleShipmentItems,
    schema: S.sampleShipmentItemSchema,
    sensitivity: touches(['unitValueCents'], '修改金额'),
    afterWrite: ({ after }) => {
      const parent = registry.get('sample_shipment').get(after.shipmentId as string);
      if (parent) automation.onSamplesChanged(parent.influencerId as string);
    },
  },
  { name: 'sample_return', table: T.sampleReturns, schema: S.sampleReturnSchema },
  {
    name: 'sample_return_item',
    table: T.sampleReturnItems,
    schema: S.sampleReturnItemSchema,
    afterWrite: ({ before, after, actor }) => {
      // 回收问题次数（PRD 5.5）：每出现一次质检问题或缺件，达人的计数加 1。
      // 已删除的行不计入，所以撤销创建、撤销删除都会得到正确的增减。
      const isIssue = (r: Row | null) =>
        !!r && !r.deletedAt && !!r.qaResult && r.qaResult !== '完好';
      const delta = (isIssue(after) ? 1 : 0) - (isIssue(before) ? 1 : 0);
      const ret = registry.get('sample_return').get(after.returnId as string);
      if (!ret) return;
      if (delta) {
        const inf = registry.get('influencer').require(ret.influencerId as string);
        const next = Math.max(0, ((inf.recycleIssueCount as number) ?? 0) + delta);
        registry
          .get('influencer')
          .update({ ...actor, source: '回收问题次数自动计数' }, inf.id as string, {
            recycleIssueCount: next,
          });
      }
      automation.onSamplesChanged(ret.influencerId as string);
    },
  },
  {
    name: 'sample_writeoff',
    table: T.sampleWriteoffs,
    schema: S.sampleWriteoffSchema,
    afterWrite: ({ after }) => automation.onSamplesChanged(after.influencerId as string),
  },
  { name: 'attachment', table: T.attachments, schema: S.attachmentSchema },
  {
    name: 'field_def',
    table: T.fieldDefs,
    schema: S.fieldDefSchema,
    filterFields: ['entity'],
    sortFields: ['createdAt'],
  },
  { name: 'mapping_template', table: T.mappingTemplates, schema: S.mappingTemplateSchema },
  { name: 'import_batch', table: T.importBatches, schema: S.importBatchSchema },
  { name: 'outbound_policy', table: T.outboundPolicies, schema: S.outboundPolicySchema },
  {
    name: 'outbound_log',
    table: T.outboundLogs,
    schema: S.outboundLogSchema,
    sortFields: ['createdAt'],
  },
];

/** 现在就有 users 表：单人模式自动使用默认用户（铁律 9）。 */
export function ensureDefaultUser(db: Db): string {
  const existing = db.select().from(T.users).where(eq(T.users.isDefault, true)).get();
  if (existing) return existing.id;
  const id = newId();
  db.insert(T.users).values({ id, name: '我', isDefault: true, createdBy: id, ownerId: id }).run();
  return id;
}

export function createDomain(db: Db) {
  const services = new Map<string, EntityService>();
  const registry: ServiceRegistry = {
    get(entity) {
      const s = services.get(entity);
      if (!s) throw new Error(`未知实体：${entity}`);
      return s;
    },
  };
  const userId = ensureDefaultUser(db);
  const userActor = (extra: Partial<Actor> = {}): Actor => ({ type: 'user', userId, ...extra });
  const settings = new SettingsService(db, registry, () => userActor({ source: '系统默认值' }));
  const automation = new CooperationAutomation(db, registry, () => userActor());
  for (const c of makeConfigs({ registry, settings, automation })) {
    const svc =
      c.name === 'influencer'
        ? new InfluencerService(db, c, registry)
        : c.name === 'cooperation'
          ? new CooperationService(db, c, registry, settings)
          : c.name === 'follow_up'
            ? new FollowUpService(db, c, registry)
            : new EntityService(db, c, registry);
    services.set(c.name, svc);
  }

  const samples = new SampleService(db, registry, settings);
  const review = new ReviewService(db, registry);

  return {
    db,
    userId,
    userActor,
    /** 按实体名取服务，如 domain.entity('cooperation') */
    entity: (name: string) => registry.get(name),
    registry,
    influencers: services.get('influencer') as InfluencerService,
    cooperations: services.get('cooperation') as CooperationService,
    settings,
    automation,
    read: new ReadModels(db, registry),
    samples,
    review,
    reviewView: new ReviewView(db, registry),
    home: new HomeService(registry, samples, review, settings),
    newBatchId: () => newId(),
    /** 多个写操作放进同一事务（失败整体回滚）。 */
    transaction: <T>(fn: () => T): T => db.transaction(() => fn()),
  };
}

export type Domain = ReturnType<typeof createDomain>;

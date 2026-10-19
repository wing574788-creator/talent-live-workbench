import { and, desc, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/index.ts';
import { changeLog } from '../db/schema.ts';
import { todayShanghai } from './automation.ts';
import { DomainError } from './errors.ts';
import {
  EntityService,
  type EntityConfig,
  type QueryOptions,
  type ServiceRegistry,
} from './entity-service.ts';
import type { SettingsService } from './settings-service.ts';
import type { Actor, Row, WriteResult } from './types.ts';

const dayDiff = (from: string, to: string) =>
  Math.round((Date.parse(to) - Date.parse(from)) / 86400_000);

/** 合作：列表/看板/详情的聚合读取，以及业务状态校验用到的跟进统计。 */
export class CooperationService extends EntityService {
  constructor(
    db: Db,
    config: EntityConfig,
    registry: ServiceRegistry,
    private readonly settings: SettingsService,
  ) {
    super(db, config, registry);
  }

  /** 某合作的跟进统计：次数、最近一次时间、是否连续 N 次"待回复" */
  followStats(cooperationId: string, followUps?: Row[]) {
    const list = (
      followUps ?? this.registry.get('follow_up').findBy('cooperationId', cooperationId)
    ).sort((a, b) => String(b.occurredAt).localeCompare(String(a.occurredAt)));
    const n = this.settings.get('replyStallCount');
    const stalled = list.length >= n && list.slice(0, n).every((f) => f.followStatus === '待回复');
    const last = list[0]?.occurredAt as string | undefined;
    return {
      followCount: list.length,
      lastFollowAt: last ?? null,
      daysSinceFollow: last ? Math.max(0, dayDiff(last.slice(0, 10), todayShanghai())) : null,
      stalled,
      stallCount: n,
    };
  }

  /** 列表/看板：每行带达人、账号、商品、跟进统计。支持按达人昵称或账号 ID 搜索。 */
  listEnriched(opts: QueryOptions) {
    const q = opts.q?.trim();
    const like = q ? `%${q.replace(/[%_\\]/g, (c) => '\\' + c)}%` : undefined;
    const extra = like
      ? sql`(${this.cols.influencerId} in (select id from influencers where nickname like ${like} escape '\\' and deleted_at is null)
          or ${this.cols.platformAccountId} in (select id from platform_accounts where account_id like ${like} escape '\\' and deleted_at is null))`
      : undefined;
    const { rows, total } = this.query({ ...opts, q: undefined, limit: opts.limit ?? 500 }, extra);

    const influencers = new Map(
      this.registry
        .get('influencer')
        .list()
        .map((r) => [r.id, r]),
    );
    const accounts = new Map(
      this.registry
        .get('platform_account')
        .list()
        .map((r) => [r.id, r]),
    );
    const products = new Map(
      this.registry
        .get('product')
        .list()
        .map((r) => [r.id, r]),
    );
    const byCoop = (rowsOf: Row[], key: string) => {
      const m = new Map<string, Row[]>();
      for (const r of rowsOf) m.set(r[key] as string, [...(m.get(r[key] as string) ?? []), r]);
      return m;
    };
    const cps = byCoop(this.registry.get('cooperation_product').list(), 'cooperationId');
    const fus = byCoop(
      this.registry
        .get('follow_up')
        .list()
        .filter((f) => f.cooperationId),
      'cooperationId',
    );
    return {
      total,
      rows: rows.map((c) => {
        const items = cps.get(c.id) ?? [];
        const pcts = items
          .map((i) => i.commissionPct as number | null)
          .filter((p): p is number => p != null);
        const inf = influencers.get(c.influencerId as string);
        const acc = accounts.get(c.platformAccountId as string);
        return {
          ...c,
          influencerNickname: inf?.nickname ?? '（已删除）',
          platform: acc?.platform,
          accountId: acc?.accountId,
          productCount: items.length,
          productNames: items.map((i) => products.get(i.productId as string)?.name).filter(Boolean),
          commissionMin: pcts.length ? Math.min(...pcts) : null,
          commissionMax: pcts.length ? Math.max(...pcts) : null,
          commissionUnset: items.some((i) => i.commissionPct == null),
          ...this.followStats(c.id, fus.get(c.id) ?? []),
        };
      }),
    };
  }

  detail(id: string) {
    const cooperation = this.require(id);
    const reg = this.registry;
    const productSvc = reg.get('product');
    const items = reg
      .get('cooperation_product')
      .findBy('cooperationId', id)
      .map((cp) => ({ ...cp, product: productSvc.get(cp.productId as string) }));
    const followUps = reg
      .get('follow_up')
      .findBy('cooperationId', id)
      .sort((a, b) => String(b.occurredAt).localeCompare(String(a.occurredAt)));
    const history = this.db
      .select()
      .from(changeLog)
      .where(and(eq(changeLog.entity, 'cooperation'), eq(changeLog.entityId, id)))
      .orderBy(desc(changeLog.id))
      .limit(50)
      .all();
    return {
      cooperation,
      influencer: reg.get('influencer').get(cooperation.influencerId as string),
      account: reg.get('platform_account').get(cooperation.platformAccountId as string),
      contact: cooperation.contactId
        ? reg.get('contact').get(cooperation.contactId as string)
        : null,
      products: items,
      followUps,
      shipments: reg.get('sample_shipment').findBy('cooperationId', id),
      stats: this.followStats(id, followUps),
      history,
    };
  }
}

/** 跟进记录：保存后把跟进状态、下次跟进日期同步到关联合作（PRD 5.4）。 */
export class FollowUpService extends EntityService {
  override create(actor: Actor, input: unknown): WriteResult {
    const data = this.parse(this.config.schema, input) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!data.cooperationId && !data.influencerId && !data.contactId) {
      throw new DomainError('validation', '跟进记录至少要关联合作、达人或联系人之一');
    }
    if (data.influencerId) this.registry.get('influencer').require(data.influencerId);
    if (data.contactId) this.registry.get('contact').require(data.contactId);
    return this.tx(() => {
      const coopSvc = this.registry.get('cooperation');
      const coop = data.cooperationId ? coopSvc.require(data.cooperationId) : undefined;
      const sync: Record<string, unknown> = {};
      if (coop) {
        if (data.followStatus) sync.followStatus = data.followStatus;
        if (data.nextFollowDate) sync.nextFollowDate = data.nextFollowDate;
        // 洽谈中的合作必须有下次跟进日期，避免跟一次就断掉
        const next = (sync.nextFollowDate ?? coop.nextFollowDate) as string | null;
        if (coop.stage === '洽谈中' && !next) {
          throw new DomainError('validation', '洽谈中的合作需要填写下次跟进日期');
        }
        // 没有显式填写达人时，沿用合作所属的达人，时间线才能在达人详情里看到
        if (!data.influencerId) data.influencerId = coop.influencerId;
      }
      const res = this.insertRow(actor, data);
      if (coop && Object.keys(sync).length) coopSvc.update(actor, coop.id, sync);
      // 跟进挂在联系人上时，把下次跟进日期同步给联系人（首页今日待跟进包含联系人）
      if (data.contactId && data.nextFollowDate) {
        this.registry
          .get('contact')
          .update(actor, data.contactId, { nextFollowDate: data.nextFollowDate });
      }
      return res;
    });
  }
}

import { addDays, keyTotals } from './sample-ledger.ts';
import { todayShanghai } from './automation.ts';
import type { ServiceRegistry } from './entity-service.ts';
import type { ReviewService } from './review-service.ts';
import type { SampleService } from './sample-service.ts';
import type { SettingsService } from './settings-service.ts';
import type { Row } from './types.ts';

const dayDiff = (from: string, to: string) =>
  Math.round((Date.parse(to.slice(0, 10)) - Date.parse(from.slice(0, 10))) / 86400_000);

/** 不再需要跟进的阶段 */
const CLOSED = new Set(['完成', '流失', '放弃', '暂缓']);
/** 已经开播（含之后）的阶段 */
const LIVE_DONE = new Set(['已开播', '待退样', '待复盘', '完成']);

export type AlertTone = 'red' | 'gray';
export interface SampleAlert {
  type: 'overdue' | 'qa' | 'notLive' | 'pendingShip';
  text: string;
  badge: string;
  tone: AlertTone;
}

/**
 * 首页数据（PRD 5.1）：今日待跟进、寄样预警、近 7 天开播、四个数字。
 * 只读聚合，没有 AI 时也能完整显示；摘要部分按规则生成，接入模型后由 AI 摘要替换。
 */
export class HomeService {
  constructor(
    private readonly reg: ServiceRegistry,
    private readonly samples: SampleService,
    private readonly review: ReviewService,
    private readonly settings: SettingsService,
  ) {}

  dashboard(today = todayShanghai()) {
    const dueFollows = this.dueFollows(today);
    const sampleAlerts = this.sampleAlerts(today);
    const upcomingLives = this.upcomingLives(today);
    const summaries = this.samples.summaries(today);
    const outstanding = summaries.reduce((n, s) => n + s.outstanding, 0);
    const overdueQty = summaries.reduce((n, s) => n + s.overdueQty, 0);
    const cards = {
      dueFollow: {
        count: dueFollows.length,
        overdue: dueFollows.filter((d) => d.overdueDays > 0).length,
      },
      samples: { outstanding, overdueQty },
      live7: {
        count: upcomingLives.length,
        unconfirmed: upcomingLives.filter((l) => l.commissionUnconfirmed).length,
      },
      pendingReview: this.review.pendingCount(),
    };
    return {
      today,
      cards,
      dueFollows,
      sampleAlerts,
      upcomingLives,
      highlights: this.highlights(cards, dueFollows, sampleAlerts, upcomingLives),
    };
  }

  /** 下次跟进日期 ≤ 今天的合作和联系人，按逾期天数从多到少 */
  dueFollows(today = todayShanghai()) {
    const influencers = new Map(
      this.reg
        .get('influencer')
        .list()
        .map((r) => [r.id, r]),
    );
    const accounts = new Map(
      this.reg
        .get('platform_account')
        .list()
        .map((r) => [r.id, r]),
    );
    const products = new Map(
      this.reg
        .get('product')
        .list()
        .map((r) => [r.id, r]),
    );
    const cps = this.reg.get('cooperation_product').list();
    const followUps = this.reg.get('follow_up').list();
    const lastAction = (match: (f: Row) => boolean) =>
      followUps
        .filter(match)
        .filter((f) => f.nextAction)
        .sort((a, b) => String(b.occurredAt).localeCompare(String(a.occurredAt)))[0]?.nextAction as
        string | undefined;

    const rows: {
      kind: 'cooperation' | 'contact';
      id: string;
      name: string;
      sub: string;
      stage: string | null;
      nextFollowDate: string;
      overdueDays: number;
      nextAction: string | null;
    }[] = [];

    for (const c of this.reg.get('cooperation').list()) {
      const next = c.nextFollowDate as string | null;
      if (!next || next > today || CLOSED.has(c.stage as string)) continue;
      const names = cps
        .filter((cp) => cp.cooperationId === c.id)
        .map((cp) => products.get(cp.productId as string)?.name as string | undefined)
        .filter(Boolean);
      const platform = accounts.get(c.platformAccountId as string)?.platform as string | undefined;
      rows.push({
        kind: 'cooperation',
        id: c.id as string,
        name: (influencers.get(c.influencerId as string)?.nickname as string) ?? '（已删除）',
        sub: [
          names.length
            ? names.slice(0, 2).join('、') + (names.length > 2 ? ` 等 ${names.length} 款` : '')
            : '未选商品',
          platform,
        ]
          .filter(Boolean)
          .join(' · '),
        stage: c.stage as string,
        nextFollowDate: next,
        overdueDays: dayDiff(next, today),
        nextAction: lastAction((f) => f.cooperationId === c.id) ?? null,
      });
    }
    for (const ct of this.reg.get('contact').list()) {
      const next = ct.nextFollowDate as string | null;
      if (!next || next > today) continue;
      rows.push({
        kind: 'contact',
        id: ct.id as string,
        name: ct.name as string,
        sub: [ct.type, ct.org].filter(Boolean).join(' · '),
        stage: null,
        nextFollowDate: next,
        overdueDays: dayDiff(next, today),
        nextAction: lastAction((f) => f.contactId === ct.id) ?? null,
      });
    }
    return rows.sort((a, b) => b.overdueDays - a.overdueDays || a.name.localeCompare(b.name));
  }

  /** 寄样预警，按达人汇总：逾期未寄回、质检待处理、签收后久未开播、待寄样超期 */
  sampleAlerts(today = todayShanghai()) {
    const signedDays = this.settings.get('signedNotLiveDays');
    const shipDays = this.settings.get('shipOverdueDays');
    const shipments = this.reg.get('sample_shipment').list();
    const notLive = new Map(this.signedNotLive(0, today).map((x) => [x.influencerId, x]));
    const out = [];
    for (const s of this.samples.summaries(today)) {
      const id = s.influencer.id as string;
      const alerts: SampleAlert[] = [];
      const totals = keyTotals(this.reg, id);
      const dues = totals
        .filter((t) => t.outstanding > 0 && t.dueBackDate)
        .map((t) => t.dueBackDate!)
        .sort();

      if (s.overdueQty > 0) {
        alerts.push({
          type: 'overdue',
          text: `在外 ${s.outstanding} 件 · 最早应寄回 ${dues[0] ?? '—'}`,
          badge: `逾期 ${s.overdueQty} 件`,
          tone: 'red',
        });
      }
      if (s.qaPending > 0) {
        alerts.push({
          type: 'qa',
          text: `${s.qaPending} 件退回的质检或处理结果待完善`,
          badge: '质检问题',
          tone: 'gray',
        });
      }
      const nl = notLive.get(id);
      if (nl && nl.days > signedDays) {
        alerts.push({
          type: 'notLive',
          text: `签收 ${nl.days} 天，${nl.scheduled ? '尚未开播' : '尚未排期'}`,
          badge: '未开播',
          tone: 'gray',
        });
      }
      const waiting = shipments
        .filter((x) => x.influencerId === id && x.status === '待寄样')
        .map((x) => dayDiff(x.createdAt as string, today))
        .filter((d) => d > shipDays);
      if (waiting.length) {
        alerts.push({
          type: 'pendingShip',
          text: `${waiting.length} 张待寄样单已超过 ${shipDays} 天未寄出（最久 ${Math.max(...waiting)} 天）`,
          badge: '待寄样超期',
          tone: 'gray',
        });
      }
      if (alerts.length)
        out.push({
          influencerId: id,
          nickname: s.influencer.nickname as string,
          outstanding: s.outstanding,
          alerts,
        });
    }
    const weight = (a: { alerts: SampleAlert[] }) =>
      a.alerts.some((x) => x.type === 'overdue')
        ? 2
        : a.alerts.some((x) => x.type === 'qa')
          ? 1
          : 0;
    return out.sort((a, b) => weight(b) - weight(a) || b.outstanding - a.outstanding);
  }

  /**
   * 样衣还在外、签收已超过 minDays 天、对应合作还没开播的达人（"签收超过两周还没开播的有哪些"）。
   * 取该达人最早一张已签收的寄样单，和寄样预警用同一套口径。
   */
  signedNotLive(minDays: number, today = todayShanghai()) {
    const coops = this.reg.get('cooperation').list();
    const shipments = this.reg.get('sample_shipment').list();
    const out: {
      influencerId: string;
      nickname: string;
      outstanding: number;
      signedAt: string;
      days: number;
      scheduled: boolean;
    }[] = [];
    for (const s of this.samples.summaries(today)) {
      if (s.outstanding <= 0) continue;
      const id = s.influencer.id as string;
      const signed = shipments
        .filter((x) => x.influencerId === id && x.status === '已签收' && x.signedAt)
        .sort((a, b) => String(a.signedAt).localeCompare(String(b.signedAt)))[0];
      if (!signed) continue;
      const days = dayDiff(signed.signedAt as string, today);
      const mine = signed.cooperationId
        ? coops.filter((c) => c.id === signed.cooperationId)
        : coops.filter((c) => c.influencerId === id);
      if (days < minDays || mine.some((c) => LIVE_DONE.has(c.stage as string))) continue;
      out.push({
        influencerId: id,
        nickname: s.influencer.nickname as string,
        outstanding: s.outstanding,
        signedAt: (signed.signedAt as string).slice(0, 10),
        days,
        scheduled: mine.some((c) => c.liveDate),
      });
    }
    return out.sort((a, b) => b.days - a.days);
  }

  /** 近 7 天（含今天）待开播的合作；标出挂链或佣金未确认的 */
  upcomingLives(today = todayShanghai(), days = 7) {
    const end = addDays(today, days);
    const influencers = new Map(
      this.reg
        .get('influencer')
        .list()
        .map((r) => [r.id, r]),
    );
    const accounts = new Map(
      this.reg
        .get('platform_account')
        .list()
        .map((r) => [r.id, r]),
    );
    const cps = this.reg.get('cooperation_product').list();
    return this.reg
      .get('cooperation')
      .list()
      .filter((c) => {
        const d = c.liveDate as string | null;
        return !!d && d >= today && d <= end && !CLOSED.has(c.stage as string);
      })
      .map((c) => {
        const mine = cps.filter((cp) => cp.cooperationId === c.id);
        return {
          cooperationId: c.id as string,
          influencerNickname:
            (influencers.get(c.influencerId as string)?.nickname as string) ?? '（已删除）',
          platform: accounts.get(c.platformAccountId as string)?.platform as string | undefined,
          liveDate: c.liveDate as string,
          liveSlot: (c.liveSlot as string | null) ?? null,
          stage: c.stage as string,
          commissionUnconfirmed: mine.length === 0 || mine.some((cp) => cp.commissionPct == null),
          linkMissing: !c.linkMethod,
        };
      })
      .sort((a, b) => a.liveDate.localeCompare(b.liveDate));
  }

  /** 没有接入模型时的规则摘要；有 AI 摘要后由它替换（阶段 7） */
  private highlights(
    cards: { pendingReview: number },
    due: { name: string; overdueDays: number }[],
    alerts: { nickname: string; alerts: SampleAlert[] }[],
    lives: {
      liveDate: string;
      influencerNickname: string;
      commissionUnconfirmed: boolean;
      linkMissing: boolean;
    }[],
  ) {
    const lines: string[] = [];
    const overdue = due.filter((d) => d.overdueDays > 0);
    if (overdue.length) {
      lines.push(
        `${overdue
          .map((d) => d.name)
          .slice(0, 3)
          .join(
            '、',
          )}${overdue.length > 3 ? ' 等' : ''} 的跟进已逾期，最久 ${overdue[0]!.overdueDays} 天。`,
      );
    }
    const od = alerts.find((a) => a.alerts.some((x) => x.type === 'overdue'));
    if (od)
      lines.push(
        `${od.nickname} 的样衣已超过应寄回日期（${od.alerts.find((x) => x.type === 'overdue')!.badge}）。`,
      );
    const first = lives.find((l) => l.commissionUnconfirmed || l.linkMissing);
    if (first)
      lines.push(
        `${first.liveDate.slice(5).replace('-', '月')}日 ${first.influencerNickname} 开播，${first.commissionUnconfirmed ? '佣金还没确认' : '还没确认挂链方式'}。`,
      );
    if (cards.pendingReview) lines.push(`有 ${cards.pendingReview} 条改动等待审核。`);
    return lines;
  }
}

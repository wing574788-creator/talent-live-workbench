/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Db } from '../db/index.ts';
import { todayShanghai } from './automation.ts';
import type { ServiceRegistry } from './entity-service.ts';
import { DomainError } from './errors.ts';
import {
  COUNTED_SHIPMENT_STATUSES,
  addDays,
  keyOf,
  keyTotals,
  outstandingOf,
  outstandingTotal,
  replayLedger,
  type KeyTotal,
} from './sample-ledger.ts';
import type { SettingsService } from './settings-service.ts';
import { appliedOf, type Actor, type Row } from './types.ts';

const label = (t: { styleNo: string; productName: string; color: string; size: string }) =>
  `${t.styleNo} ${t.productName} ${t.color} ${t.size}`;

/**
 * 样品台账的领域服务（阶段 4）。寄样单、退样单、核销的写入都经过这里做业务校验，
 * 再交给实体服务落库（所以仍然记变更日志、可撤销）。
 */
export class SampleService {
  constructor(
    private readonly db: Db,
    private readonly reg: ServiceRegistry,
    private readonly settings: SettingsService,
  ) {}

  private tx<T>(fn: () => T): T {
    return this.db.transaction(() => fn());
  }

  // ───────────── 寄样单 ─────────────
  /** 新建待寄样单：此时还没发货，只记下"要给谁寄什么"。 */
  createShipment(
    actor: Actor,
    input: { influencerId: string; cooperationId?: string | null; items: any[] },
  ): Row {
    const inf = this.reg.get('influencer').require(input.influencerId);
    if (input.cooperationId) {
      const c = this.reg.get('cooperation').require(input.cooperationId);
      if (c.influencerId !== inf.id) throw new DomainError('validation', '合作不属于该达人');
    }
    const items = Array.isArray(input.items) ? input.items : [];
    if (!items.length) throw new DomainError('validation', '至少要有一个款色码');
    return this.tx(() => {
      const s = appliedOf(
        this.reg.get('sample_shipment').create(actor, {
          influencerId: inf.id,
          cooperationId: input.cooperationId ?? null,
          status: '待寄样',
        }),
      ).row;
      for (const raw of items) {
        const names = raw.productId
          ? this.productNames(raw.productId)
          : { styleNo: raw.styleNo, productName: raw.productName };
        appliedOf(
          this.reg.get('sample_shipment_item').create(actor, {
            shipmentId: s.id,
            productId: raw.productId ?? null,
            styleNo: names.styleNo,
            productName: names.productName,
            color: raw.color,
            size: raw.size,
            qty: raw.qty,
            unitValueCents: raw.unitValueCents ?? null,
          }),
        );
      }
      return s;
    });
  }

  private productNames(productId: string) {
    const p = this.reg.get('product').require(productId);
    return { styleNo: p.styleNo as string, productName: p.name as string };
  }

  /** 寄出：填写收货地址、快递信息、寄出日期；状态变为已寄出，样衣计入在外。 */
  ship(
    actor: Actor,
    id: string,
    input: {
      shippedAt?: string | null;
      carrier?: string | null;
      trackingNo?: string | null;
      recipient?: string | null;
      phone?: string | null;
      address?: string | null;
      dueBackDate?: string | null;
    } = {},
  ): Row {
    return this.tx(() => {
      const svc = this.reg.get('sample_shipment');
      const s = svc.require(id);
      if (s.status !== '待寄样') {
        throw new DomainError('invalid_state', `当前状态为「${s.status}」，只能对待寄样单执行寄出`);
      }
      const addr = this.resolveAddress(s.influencerId as string, input);
      const shippedAt = input.shippedAt ?? todayShanghai();
      const row = appliedOf(
        svc.update(actor, id, {
          status: '已寄出',
          shippedAt,
          carrier: input.carrier ?? null,
          trackingNo: input.trackingNo ?? null,
          ...addr,
        }),
      ).row;
      return this.setDue(actor, row, input.dueBackDate);
    });
  }

  /** 批量标记寄出（PRD 5.5 待寄样页）。逐条独立事务，失败的单条不影响其他。 */
  shipMany(
    actor: Actor,
    ids: string[],
    shippedAt: string | null,
  ): { shipped: string[]; failed: { id: string; error: string }[] } {
    const shipped: string[] = [];
    const failed: { id: string; error: string }[] = [];
    for (const id of ids) {
      try {
        this.ship(actor, id, { shippedAt });
        shipped.push(id);
      } catch (err) {
        failed.push({ id, error: (err as Error).message });
      }
    }
    return { shipped, failed };
  }

  sign(actor: Actor, id: string, signedAt: string | null): Row {
    return this.tx(() => {
      const svc = this.reg.get('sample_shipment');
      const s = svc.require(id);
      if (s.status !== '已寄出') {
        throw new DomainError(
          'invalid_state',
          `当前状态为「${s.status}」，只能对已寄出的寄样单登记签收`,
        );
      }
      const row = appliedOf(
        svc.update(actor, id, { status: '已签收', signedAt: signedAt ?? todayShanghai() }),
      ).row;
      return this.setDue(actor, row, undefined);
    });
  }

  /** 延期：样衣留给下一场用时，不退回也不重新寄出，只延后应寄回日期，并记一条说明（写进变更日志的来源）。 */
  extendDue(actor: Actor, id: string, dueBackDate: string, note: string): Row {
    const note2 = note.trim();
    if (!note2) throw new DomainError('validation', '延期需要填写说明');
    const svc = this.reg.get('sample_shipment');
    const s = svc.require(id);
    if (!COUNTED_SHIPMENT_STATUSES.includes(s.status as string)) {
      throw new DomainError('invalid_state', '只有已寄出的样衣可以延期');
    }
    return appliedOf(svc.update({ ...actor, source: `延期：${note2}` }, id, { dueBackDate })).row;
  }

  /** 应寄回日期：有开播日 → 开播日 + N；未排期 → 签收日 + M。只在还没有值时自动填，之后可手动改。 */
  private setDue(actor: Actor, row: Row, explicit: string | null | undefined): Row {
    const svc = this.reg.get('sample_shipment');
    if (explicit) return appliedOf(svc.update(actor, row.id, { dueBackDate: explicit })).row;
    if (row.dueBackDate) return row;
    const liveDate = row.cooperationId
      ? (this.reg.get('cooperation').get(row.cooperationId as string)?.liveDate as string | null)
      : null;
    let due: string | null = null;
    if (liveDate) due = addDays(liveDate, this.settings.get('returnAfterLiveDays'));
    else if (row.signedAt)
      due = addDays(row.signedAt as string, this.settings.get('returnAfterSignDays'));
    if (!due) return row;
    return appliedOf(
      svc.update({ ...actor, source: '应寄回日期自动计算' }, row.id, { dueBackDate: due }),
    ).row;
  }

  private resolveAddress(
    influencerId: string,
    input: { recipient?: string | null; phone?: string | null; address?: string | null },
  ) {
    if (input.address?.trim()) {
      return {
        recipient: input.recipient ?? null,
        phone: input.phone ?? null,
        address: input.address.trim(),
      };
    }
    const addrs = this.reg.get('influencer_address').findBy('influencerId', influencerId);
    const def = addrs.find((a) => a.isDefault) ?? addrs[0];
    if (!def) throw new DomainError('validation', '该达人还没有收货地址，请先在达人详情里添加');
    return {
      recipient: def.recipient as string,
      phone: (def.phone as string | null) ?? null,
      address: def.address as string,
    };
  }

  // ───────────── 退样单 ─────────────
  createReturn(
    actor: Actor,
    input: {
      influencerId: string;
      returnedAt: string;
      carrier?: string | null;
      trackingNo?: string | null;
      items: any[];
    },
  ): Row {
    const inf = this.reg.get('influencer').require(input.influencerId);
    const items = Array.isArray(input.items) ? input.items.filter((i) => Number(i.qty) > 0) : [];
    if (!items.length) throw new DomainError('validation', '请至少勾选一个款色码并填写退回数量');
    const totals = new Map(keyTotals(this.reg, inf.id).map((t) => [t.key, t]));
    const need = new Map<string, number>();
    for (const it of items) {
      const k = keyOf(it);
      need.set(k, (need.get(k) ?? 0) + Number(it.qty));
    }
    for (const [k, n] of need) {
      const t = totals.get(k);
      const avail = t?.outstanding ?? 0;
      if (!t || n > avail) {
        const shown = t ? label(t) : k.replace(/\|/g, ' ');
        throw new DomainError('validation', `${shown} 在外只有 ${avail} 件，本次退回 ${n} 件`);
      }
    }
    return this.tx(() => {
      const ret = appliedOf(
        this.reg.get('sample_return').create(actor, {
          influencerId: inf.id,
          returnedAt: input.returnedAt,
          carrier: input.carrier ?? null,
          trackingNo: input.trackingNo ?? null,
        }),
      ).row;
      for (const it of items) {
        const t = totals.get(keyOf(it))!;
        appliedOf(
          this.reg.get('sample_return_item').create(actor, {
            returnId: ret.id,
            styleNo: t.styleNo,
            productName: t.productName,
            color: t.color,
            size: t.size,
            qty: Number(it.qty),
            qaResult: it.qaResult ?? null,
            photoAttachmentIds: it.photoAttachmentIds ?? [],
            disposition: it.disposition ?? null,
          }),
        );
      }
      return ret;
    });
  }

  // ───────────── 核销 ─────────────
  createWriteoff(
    actor: Actor,
    input: {
      influencerId: string;
      styleNo: string;
      color: string;
      size: string;
      qty: number;
      reason: string;
      note?: string | null;
      occurredAt: string;
    },
  ): Row {
    const inf = this.reg.get('influencer').require(input.influencerId);
    const k = keyOf(input);
    const avail = outstandingOf(this.reg, inf.id, k);
    if (Number(input.qty) > avail) {
      throw new DomainError(
        'validation',
        `${input.styleNo} ${input.color} ${input.size} 在外只有 ${avail} 件，不能核销 ${input.qty} 件`,
      );
    }
    const t = keyTotals(this.reg, inf.id).find((x) => x.key === k)!;
    return appliedOf(
      this.reg.get('sample_writeoff').create(actor, {
        influencerId: inf.id,
        styleNo: t.styleNo,
        productName: t.productName,
        color: t.color,
        size: t.size,
        qty: Number(input.qty),
        reason: input.reason,
        note: input.note ?? null,
        occurredAt: input.occurredAt,
      }),
    ).row;
  }

  // ───────────── 结清后清除收货地址（PRD 5.5 第 8 条） ─────────────
  clearAddresses(actor: Actor, influencerId: string): number {
    this.reg.get('influencer').require(influencerId);
    if (outstandingTotal(this.reg, influencerId) > 0) {
      throw new DomainError('invalid_state', '该达人还有在外样品，结清后才能清除收货地址');
    }
    const svc = this.reg.get('influencer_address');
    const rows = svc.findBy('influencerId', influencerId);
    this.tx(() => rows.forEach((r) => svc.delete(actor, r.id as string)));
    return rows.length;
  }

  // ───────────── 读取 ─────────────
  /** 列表：每个有样品记录的达人一行，带各状态计数，供寄样页筛选。 */
  summaries(today = todayShanghai()) {
    const influencers = this.reg.get('influencer').list();
    const shipments = this.reg.get('sample_shipment').list();
    const retItems = this.reg.get('sample_return_item').list();
    const rows = [];
    for (const inf of influencers) {
      const mine = shipments.filter((s) => s.influencerId === inf.id);
      const hasRet = this.reg.get('sample_return').findBy('influencerId', inf.id).length > 0;
      if (!mine.length && !hasRet) continue;
      const totals = keyTotals(this.reg, inf.id);
      const outstanding = totals.reduce((n, t) => n + Math.max(0, t.outstanding), 0);
      const overdueQty = totals
        .filter((t) => t.outstanding > 0 && t.dueBackDate && t.dueBackDate < today)
        .reduce((n, t) => n + t.outstanding, 0);
      const returnIds = new Set(
        this.reg
          .get('sample_return')
          .findBy('influencerId', inf.id)
          .map((r) => r.id),
      );
      const qaPending = retItems.filter(
        (it) =>
          returnIds.has(it.returnId as string) &&
          (it.qaResult == null || (it.qaResult !== '完好' && it.disposition == null)),
      ).length;
      rows.push({
        influencer: { id: inf.id, nickname: inf.nickname },
        outstanding,
        overdueQty,
        pendingShip: mine.filter((s) => s.status === '待寄样').length,
        qaPending,
        settled:
          outstanding === 0 &&
          mine.some((s) => COUNTED_SHIPMENT_STATUSES.includes(s.status as string)),
        recycleIssueCount: inf.recycleIssueCount,
      });
    }
    return rows.sort((a, b) => b.overdueQty - a.overdueQty || b.outstanding - a.outstanding);
  }

  /** 跨达人的待寄样单（寄样页「待寄样」，可批量标记寄出），按创建时间从早到晚。 */
  pendingShipments() {
    const infs = new Map(
      this.reg
        .get('influencer')
        .list()
        .map((i) => [i.id, i]),
    );
    const itemsOf = this.reg.get('sample_shipment_item');
    const rows = this.reg
      .get('sample_shipment')
      .list()
      .filter((s) => s.status === '待寄样')
      .map((s) => ({
        id: s.id as string,
        influencerId: s.influencerId as string,
        influencerNickname:
          (infs.get(s.influencerId as string)?.nickname as string) ?? '（已删除）',
        cooperationId: (s.cooperationId as string | null) ?? null,
        createdAt: s.createdAt as string,
        items: itemsOf.findBy('shipmentId', s.id),
      }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { rows, thresholdDays: this.settings.get('shipOverdueDays') };
  }

  /** 达人样品页：在外结余、流水时间线、累计汇总。 */
  detail(influencerId: string, today = todayShanghai()) {
    const inf = this.reg.get('influencer').require(influencerId);
    const totals = keyTotals(this.reg, inf.id).map((t) => ({
      ...t,
      overdue: t.outstanding > 0 && !!t.dueBackDate && t.dueBackDate < today,
    }));
    const shipments = this.reg.get('sample_shipment').findBy('influencerId', inf.id);
    const returns = this.reg.get('sample_return').findBy('influencerId', inf.id);
    const writeoffs = this.reg.get('sample_writeoff').findBy('influencerId', inf.id);
    const itemsOf = this.reg.get('sample_shipment_item');
    const retItemsOf = this.reg.get('sample_return_item');
    const timeline = [
      ...shipments.map((s) => ({
        type: 'ship' as const,
        id: s.id,
        at: (s.shippedAt as string | null) ?? (s.createdAt as string),
        status: s.status,
        carrier: s.carrier ?? null,
        trackingNo: s.trackingNo ?? null,
        dueBackDate: s.dueBackDate ?? null,
        signedAt: s.signedAt ?? null,
        recipient: s.recipient ?? null,
        phone: s.phone ?? null,
        address: s.address ?? null,
        cooperationId: s.cooperationId ?? null,
        items: itemsOf.findBy('shipmentId', s.id),
      })),
      ...returns.map((r) => ({
        type: 'return' as const,
        id: r.id,
        at: r.returnedAt as string,
        carrier: r.carrier ?? null,
        trackingNo: r.trackingNo ?? null,
        items: retItemsOf.findBy('returnId', r.id),
      })),
      ...writeoffs.map((w) => ({
        type: 'writeoff' as const,
        id: w.id,
        at: w.occurredAt as string,
        styleNo: w.styleNo,
        color: w.color,
        size: w.size,
        qty: w.qty,
        reason: w.reason,
        note: w.note ?? null,
      })),
    ].sort((a, b) => String(b.at).localeCompare(String(a.at)));

    const sum = (f: (t: KeyTotal) => number) => totals.reduce((n, t) => n + f(t), 0);
    return {
      influencer: inf,
      totals,
      timeline,
      pendingShipments: shipments
        .filter((s) => s.status === '待寄样')
        .map((s) => ({
          ...s,
          items: itemsOf.findBy('shipmentId', s.id),
        })),
      summary: {
        shipped: sum((t) => t.shipped),
        returned: sum((t) => t.returned),
        writtenOff: sum((t) => t.writtenOff),
        outstanding: sum((t) => Math.max(0, t.outstanding)),
        overdueQty: totals.filter((t) => t.overdue).reduce((n, t) => n + t.outstanding, 0),
        recycleIssueCount: inf.recycleIssueCount,
        canClearAddress: sum((t) => Math.max(0, t.outstanding)) === 0 && shipments.length > 0,
      },
    };
  }

  /** 供测试和调试：回放出来的寄出行（每行剩余数量）。 */
  lines(influencerId: string) {
    return replayLedger(this.reg, influencerId).lines;
  }
}

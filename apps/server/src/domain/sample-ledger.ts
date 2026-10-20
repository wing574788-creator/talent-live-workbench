import type { ServiceRegistry } from './entity-service.ts';
import type { Row } from './types.ts';

/** 计入"在外"的寄样单状态：只有已寄出之后才算（CLAUDE.md 业务要点）。 */
export const COUNTED_SHIPMENT_STATUSES = ['已寄出', '已签收'];

export const keyOf = (r: Row | Record<string, unknown>) => `${r.styleNo}|${r.color}|${r.size}`;

const cmp = (a: unknown, b: unknown) => String(a ?? '').localeCompare(String(b ?? ''));

export interface OpenLine {
  key: string;
  styleNo: string;
  productName: string;
  color: string;
  size: string;
  shipmentId: string;
  shippedAt: string | null;
  dueBackDate: string | null;
  /** 该寄出行仍未冲抵的数量 */
  open: number;
}

export interface KeyTotal {
  key: string;
  styleNo: string;
  productName: string;
  color: string;
  size: string;
  shipped: number;
  returned: number;
  writtenOff: number;
  outstanding: number;
  /** 未结清部分里最早的应寄回日期 */
  dueBackDate: string | null;
}

/**
 * 按达人重放全部寄出、退回、核销，得到每一行寄出还剩多少没冲抵。
 * 冲抵规则（PRD 4.6）：退回和核销按款号+颜色+尺码，从最早未结清的寄出记录开始冲抵。
 * 只有已寄出/已签收的寄样单参与。
 */
export function replayLedger(registry: ServiceRegistry, influencerId: string) {
  const shipments = registry
    .get('sample_shipment')
    .findBy('influencerId', influencerId)
    .filter((s) => COUNTED_SHIPMENT_STATUSES.includes(s.status as string))
    .sort((a, b) => cmp(a.shippedAt, b.shippedAt) || cmp(a.createdAt, b.createdAt));
  const itemsOf = registry.get('sample_shipment_item');
  const lines: OpenLine[] = [];
  for (const s of shipments) {
    for (const it of itemsOf.findBy('shipmentId', s.id)) {
      lines.push({
        key: keyOf(it),
        styleNo: it.styleNo as string,
        productName: it.productName as string,
        color: it.color as string,
        size: it.size as string,
        shipmentId: s.id as string,
        shippedAt: (s.shippedAt as string | null) ?? null,
        dueBackDate: (s.dueBackDate as string | null) ?? null,
        open: it.qty as number,
      });
    }
  }

  const events: { key: string; qty: number; at: string; createdAt: string }[] = [];
  const returnItems = registry.get('sample_return_item');
  for (const r of registry.get('sample_return').findBy('influencerId', influencerId)) {
    for (const it of returnItems.findBy('returnId', r.id)) {
      events.push({
        key: keyOf(it),
        qty: it.qty as number,
        at: r.returnedAt as string,
        createdAt: r.createdAt as string,
      });
    }
  }
  for (const w of registry.get('sample_writeoff').findBy('influencerId', influencerId)) {
    events.push({
      key: keyOf(w),
      qty: w.qty as number,
      at: w.occurredAt as string,
      createdAt: w.createdAt as string,
    });
  }
  events.sort((a, b) => cmp(a.at, b.at) || cmp(a.createdAt, b.createdAt));
  for (const e of events) {
    let need = e.qty;
    for (const l of lines) {
      if (need <= 0) break;
      if (l.key !== e.key || l.open <= 0) continue;
      const take = Math.min(need, l.open);
      l.open -= take;
      need -= take;
    }
  }
  return { lines, events };
}

/** 按款号+颜色+尺码汇总：累计寄出、累计退回、核销、在外、最早应寄回日期。 */
export function keyTotals(registry: ServiceRegistry, influencerId: string): KeyTotal[] {
  const { lines } = replayLedger(registry, influencerId);
  const map = new Map<string, KeyTotal>();
  const get = (src: Row | Record<string, unknown>) => {
    const k = keyOf(src);
    let t = map.get(k);
    if (!t) {
      t = {
        key: k,
        styleNo: String(src.styleNo),
        productName: String(src.productName),
        color: String(src.color),
        size: String(src.size),
        shipped: 0,
        returned: 0,
        writtenOff: 0,
        outstanding: 0,
        dueBackDate: null,
      };
      map.set(k, t);
    }
    return t;
  };
  const itemsOf = registry.get('sample_shipment_item');
  for (const s of registry.get('sample_shipment').findBy('influencerId', influencerId)) {
    if (!COUNTED_SHIPMENT_STATUSES.includes(s.status as string)) continue;
    for (const it of itemsOf.findBy('shipmentId', s.id)) get(it).shipped += it.qty as number;
  }
  for (const r of registry.get('sample_return').findBy('influencerId', influencerId)) {
    for (const it of registry.get('sample_return_item').findBy('returnId', r.id)) {
      get(it).returned += it.qty as number;
    }
  }
  for (const w of registry.get('sample_writeoff').findBy('influencerId', influencerId)) {
    get(w).writtenOff += w.qty as number;
  }
  for (const l of lines) {
    if (l.open <= 0) continue;
    const t = map.get(l.key)!;
    t.outstanding += l.open;
    if (l.dueBackDate && (!t.dueBackDate || l.dueBackDate < t.dueBackDate))
      t.dueBackDate = l.dueBackDate;
  }
  return [...map.values()].sort(
    (a, b) =>
      a.styleNo.localeCompare(b.styleNo) ||
      a.color.localeCompare(b.color) ||
      a.size.localeCompare(b.size),
  );
}

/** 在外总件数（逐款色码取非负后求和）。 */
export function outstandingTotal(registry: ServiceRegistry, influencerId: string): number {
  return keyTotals(registry, influencerId).reduce((n, t) => n + Math.max(0, t.outstanding), 0);
}

/**
 * 某场合作的在外件数：只算关联到这场合作的寄样单上还没冲抵完的部分。
 * 冲抵仍按达人整体从最早寄出开始（PRD 4.6），这里只是按寄样单归属拆开；
 * 没有关联合作的寄样单不算到任何合作上。
 */
export function outstandingForCooperation(
  registry: ServiceRegistry,
  influencerId: string,
  cooperationId: string,
): number {
  const mine = new Set(
    registry
      .get('sample_shipment')
      .findBy('influencerId', influencerId)
      .filter((s) => s.cooperationId === cooperationId)
      .map((s) => s.id as string),
  );
  if (!mine.size) return 0;
  return replayLedger(registry, influencerId)
    .lines.filter((l) => mine.has(l.shipmentId))
    .reduce((n, l) => n + Math.max(0, l.open), 0);
}

/** 按款色码的在外数量（供退回、核销时校验数量上限）。 */
export function outstandingOf(
  registry: ServiceRegistry,
  influencerId: string,
  key: string,
): number {
  return keyTotals(registry, influencerId).find((t) => t.key === key)?.outstanding ?? 0;
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

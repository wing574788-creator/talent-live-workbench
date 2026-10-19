import { addDays } from '../../domain/sample-ledger.ts';
import type { RowPlan } from '../types.ts';
import { resolveInfluencerAccount } from './cooperation.ts';
import { basePlan, hasError, noResult, pick, str, type ApplyCtx, type Handler } from './common.ts';

const SHIP_KEYS = [
  'shippedAt',
  'signedAt',
  'dueBackDate',
  'carrier',
  'trackingNo',
  'recipient',
  'phone',
  'address',
];
const itemKey = (v: Record<string, unknown>) =>
  `${str(v.styleNo)}|${str(v.color)}|${str(v.size)}`.toLowerCase();

/** 同一个包裹（达人 + 快递单号 + 寄出日期 + 状态）的多行归为一张寄样单 */
const groupKeyOf = (infId: string, v: Record<string, unknown>) =>
  `${infId}|${str(v.trackingNo).toLowerCase()}|${str(v.shippedAt)}|${str(v.status) || '待寄样'}`;

export const shipmentHandler: Handler = {
  plan(rec, ctx): RowPlan {
    const v = rec.values;
    const issues = [...rec.issues];
    const nickname = str(v.influencerNickname) || str(v.accountId);
    if (!nickname) issues.push({ level: 'error', text: '缺少达人' });
    if (!str(v.styleNo)) issues.push({ level: 'error', text: '缺少款号' });
    if (!str(v.color)) issues.push({ level: 'error', text: '缺少颜色' });
    if (!str(v.size)) issues.push({ level: 'error', text: '缺少尺码' });
    const qty = Number(v.qty);
    if (!Number.isInteger(qty) || qty <= 0)
      issues.push({ level: 'error', text: '数量应为大于 0 的整数' });
    const status = str(v.status) || '待寄样';
    if (status !== '待寄样' && !v.shippedAt)
      issues.push({
        level: 'warn',
        text: `状态是「${status}」但没有寄出日期，在外样品的先后顺序会不准`,
      });
    if (status === '已签收' && !v.signedAt)
      issues.push({ level: 'warn', text: '已签收但没有签收日期' });
    const summary = `${nickname || '（无达人）'} · ${str(v.styleNo)} ${str(v.color)} ${str(v.size)} ×${Number.isFinite(qty) ? qty : '?'}${v.trackingNo ? ` · ${v.trackingNo}` : ''}`;
    const base = basePlan(rec, summary, issues);
    if (hasError(issues)) return { ...base, status: 'error' };

    const who = resolveInfluencerAccount(v, ctx);
    if (!who.infId)
      return {
        ...base,
        status: 'error',
        issues: [...issues, { level: 'error', text: who.error ?? '找不到达人' }],
      };
    if (!ctx.ix.productByStyle(str(v.styleNo)) && !str(v.productName)) {
      issues.push({
        level: 'warn',
        text: `商品「${str(v.styleNo)}」不存在且没有填款名，款名会用款号代替`,
      });
    }
    if (!str(v.trackingNo))
      issues.push({ level: 'warn', text: '没有快递单号：重复导入这张表会生成重复的寄样单' });

    const gk = groupKeyOf(who.infId, v);
    const ik = `${gk}|${itemKey(v)}`;
    const earlier = ctx.seen.get(ik);
    if (earlier === undefined) ctx.seen.set(ik, rec.rowNo);
    const existing = str(v.trackingNo)
      ? ctx.ix.shipmentByTracking(who.infId, str(v.trackingNo))
      : undefined;

    if (earlier !== undefined) {
      return {
        ...base,
        status: 'update',
        groupKey: gk,
        existingLabel: `本次导入第 ${earlier} 行（重复的明细）`,
        changes: [],
      };
    }
    if (existing) {
      const items = ctx.d.entity('sample_shipment_item').findBy('shipmentId', existing.id);
      const has = items.some((i) => itemKey(i) === itemKey(v));
      return {
        ...base,
        status: 'update',
        groupKey: gk,
        existingId: existing.id,
        existingLabel: `已有寄样单 ${v.trackingNo}`,
        changes: has
          ? []
          : [
              {
                field: 'item',
                label: '寄样明细',
                before: null,
                after: `${str(v.styleNo)} ${str(v.color)} ${str(v.size)} ×${qty}`,
              },
            ],
      };
    }
    return { ...base, status: 'new', groupKey: gk };
  },

  apply(plan, decision, ctx: ApplyCtx) {
    const out = noResult();
    if (decision === 'skip') return { ...out, skipped: 1 };
    const rec = plan.record;
    const v = rec.values;
    const who = resolveInfluencerAccount(v, ctx);
    if (!who.infId) throw new Error(who.error ?? '找不到达人');
    const shipSvc = ctx.d.entity('sample_shipment');
    const itemSvc = ctx.d.entity('sample_shipment_item');
    const gk = plan.groupKey ?? groupKeyOf(who.infId, v);

    let shipmentId = ctx.groups.get(gk);
    if (!shipmentId && str(v.trackingNo))
      shipmentId = ctx.ix.shipmentByTracking(who.infId, str(v.trackingNo))?.id;
    let createdShipment = false;
    if (!shipmentId) {
      const status = str(v.status) || '待寄样';
      const payload: Record<string, unknown> = {
        influencerId: who.infId,
        status,
        ...pick(v, SHIP_KEYS),
      };
      // 表里没有应寄回日期、但有签收日期时，按设置里的"签收后 M 天"估算
      if (payload.dueBackDate == null && payload.signedAt) {
        payload.dueBackDate = addDays(
          String(payload.signedAt),
          ctx.d.settings.get('returnAfterSignDays'),
        );
      }
      const res = shipSvc.create(ctx.actor, payload);
      if (res.status !== 'applied') return { ...out, pending: 1 };
      shipmentId = res.row.id;
      ctx.ix.addShipment(res.row);
      createdShipment = true;
    }
    ctx.groups.set(gk, shipmentId);

    const have = itemSvc.findBy('shipmentId', shipmentId).some((i) => itemKey(i) === itemKey(v));
    if (have) return { ...out, skipped: 1 };
    const product = ctx.ix.productByStyle(str(v.styleNo));
    itemSvc.create(ctx.actor, {
      shipmentId,
      productId: product?.id ?? null,
      styleNo: str(v.styleNo),
      productName: str(v.productName) || (product ? String(product.name) : str(v.styleNo)),
      color: str(v.color),
      size: str(v.size),
      qty: Number(v.qty),
    });
    return createdShipment ? { ...out, created: 1 } : { ...out, updated: 1 };
  },
};

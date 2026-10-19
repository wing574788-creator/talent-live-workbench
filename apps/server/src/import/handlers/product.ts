import { fieldOf } from '../fields.ts';
import type { RowPlan } from '../types.ts';
import {
  basePlan,
  customJson,
  hasError,
  mergeCustom,
  mergeFields,
  noResult,
  pick,
  str,
  type ApplyCtx,
  type Handler,
} from './common.ts';

const BASE_KEYS = [
  'styleNo',
  'name',
  'status',
  'dailyPriceCents',
  'livePriceCents',
  'finalPriceCents',
  'price1111Cents',
  'price618Cents',
  'mechanism',
  'sellingPoints',
];
const label = (k: string) => fieldOf('product', k)?.label ?? k;

export const productHandler: Handler = {
  plan(rec, ctx): RowPlan {
    const v = rec.values;
    const issues = [...rec.issues];
    const styleNo = str(v.styleNo);
    const color = str(v.color);
    const size = str(v.size);
    if (!styleNo) issues.push({ level: 'error', text: '缺少款号' });
    if ((color && !size) || (!color && size))
      issues.push({ level: 'warn', text: '颜色和尺码要同时填写才会生成规格，这一行的规格被忽略' });
    const summary =
      `${styleNo || '（无款号）'} ${str(v.name)}${color && size ? ` · ${color} ${size}` : ''}`.trim();
    const base = basePlan(rec, summary, issues);
    if (!styleNo || hasError(issues)) return { ...base, status: 'error' };

    const existing = ctx.ix.productByStyle(styleNo);
    const earlier = ctx.seen.get(styleNo.toLowerCase());
    if (earlier === undefined) ctx.seen.set(styleNo.toLowerCase(), rec.rowNo);

    if (existing && !existing.id.startsWith('virtual:')) {
      const policyOf = (f: string) =>
        ctx.cfg.policy?.fields?.[f] ?? ctx.cfg.policy?.default ?? 'fill';
      const changes = mergeFields(existing, v, BASE_KEYS, policyOf, label).changes;
      const cust = customJson(rec);
      if (cust) changes.push(...mergeCustom(existing, cust, policyOf).changes);
      if (color && size)
        changes.push({ field: 'variant', label: '规格', before: null, after: `${color} ${size}` });
      return {
        ...base,
        status: 'update',
        existingId: existing.id,
        existingLabel: `${existing.styleNo} ${existing.name}`,
        changes,
      };
    }
    if (earlier !== undefined || existing) {
      return {
        ...base,
        status: 'update',
        existingLabel: `本次导入第 ${earlier ?? '?'} 行（同款号的另一规格）`,
        changes: [],
      };
    }
    if (!str(v.name))
      return {
        ...base,
        status: 'error',
        issues: [...issues, { level: 'error', text: '新商品缺少名称' }],
      };
    return { ...base, status: 'new' };
  },

  register(plan, ix) {
    const v = plan.record.values;
    ix.addProduct({
      id: `virtual:product:${plan.rowNo}`,
      version: 1,
      styleNo: str(v.styleNo),
      name: str(v.name),
    });
  },

  apply(plan, decision, ctx: ApplyCtx) {
    const out = noResult();
    if (decision === 'skip') return { ...out, skipped: 1 };
    const rec = plan.record;
    const v = rec.values;
    const styleNo = str(v.styleNo);
    const color = str(v.color);
    const size = str(v.size);
    const svc = ctx.d.entity('product');

    let existing = ctx.ix.productByStyle(styleNo);
    if (existing && decision === 'merge') {
      existing = svc.require(existing.id);
      let applied = 0;
      let pending = 0;
      const note = (r: { status: string }) => (r.status === 'pending' ? pending++ : applied++);
      const { patch } = mergeFields(existing, v, BASE_KEYS, ctx.policyOf, label);
      const cust = customJson(rec);
      const mc = cust ? mergeCustom(existing, cust, ctx.policyOf) : { custom: undefined };
      if (mc.custom) patch.custom = mc.custom;
      if (Object.keys(patch).length) note(svc.update(ctx.actor, existing.id, patch));
      if (color && size) {
        const have = ctx.d.entity('product_variant').findBy('productId', existing.id);
        if (!have.some((x) => x.color === color && x.size === size)) {
          note(
            ctx.d
              .entity('product_variant')
              .create(ctx.actor, { productId: existing.id, color, size }),
          );
        }
      }
      return {
        created: 0,
        updated: applied ? 1 : 0,
        pending: pending ? 1 : 0,
        skipped: applied || pending ? 0 : 1,
      };
    }
    if (existing) return { ...out, skipped: 1 }; // decision === 'new' 但款号已存在

    const product: Record<string, unknown> = pick(v, BASE_KEYS);
    const custom = customJson(rec);
    if (custom) product.custom = custom;
    const res = svc.create(ctx.actor, product);
    if (res.status !== 'applied') return { ...out, pending: 1 };
    ctx.ix.addProduct(res.row);
    if (color && size)
      ctx.d.entity('product_variant').create(ctx.actor, { productId: res.row.id, color, size });
    return { ...out, created: 1 };
  },
};

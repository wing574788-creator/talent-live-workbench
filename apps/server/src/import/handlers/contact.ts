import { digits } from '../indexes.ts';
import { fieldOf } from '../fields.ts';
import type { RowIssue, RowPlan } from '../types.ts';
import {
  asArray,
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
  type PlanCtx,
} from './common.ts';

const BASE_KEYS = ['name', 'type', 'org', 'wechat', 'phone', 'nextFollowDate'];
const label = (k: string) => fieldOf('contact', k)?.label ?? k;

/** 解析"关联达人"：每个引用必须能唯一对上已有达人，对不上只提示，联系人照常导入 */
function resolveRefs(refs: string[], ctx: PlanCtx): { ids: string[]; issues: RowIssue[] } {
  const ids: string[] = [];
  const issues: RowIssue[] = [];
  for (const r of refs) {
    const hit = ctx.ix.resolveInfluencer(r);
    if (hit.id) ids.push(hit.id);
    else issues.push({ level: 'warn', text: `关联达人没有建立：${hit.error}` });
  }
  return { ids, issues };
}

export const contactHandler: Handler = {
  plan(rec, ctx): RowPlan {
    const v = rec.values;
    const issues = [...rec.issues];
    const name = str(v.name);
    if (!name) issues.push({ level: 'error', text: '缺少姓名' });
    const base0 = { phone: v.phone, wechat: v.wechat, name, org: v.org, type: v.type };
    const existing = name ? ctx.ix.findContact(base0) : undefined;
    if (!existing && !v.type)
      issues.push({ level: 'error', text: '缺少类型（达人本人 / MCN / 经纪人 / 私人商务）' });
    const refs = resolveRefs(asArray(v.influencerRef), ctx);
    issues.push(...refs.issues);
    const summary = `${name || '（无姓名）'}${v.org ? ` · ${v.org}` : ''}${v.phone ? ` · ${String(v.phone).slice(0, 3)}****` : ''}`;
    const base = basePlan(rec, summary, issues);
    if (hasError(issues)) return { ...base, status: 'error' };

    const key = digits(v.phone)
      ? `p|${digits(v.phone)}`
      : str(v.wechat)
        ? `w|${str(v.wechat).toLowerCase()}`
        : `n|${name.toLowerCase()}|${str(v.org).toLowerCase()}|${str(v.type)}`;
    const earlier = ctx.seen.get(key);
    if (earlier === undefined) ctx.seen.set(key, rec.rowNo);

    if (existing) {
      const policyOf = (f: string) =>
        ctx.cfg.policy?.fields?.[f] ?? ctx.cfg.policy?.default ?? 'fill';
      const changes = mergeFields(existing, v, BASE_KEYS, policyOf, label).changes;
      const cust = customJson(rec);
      if (cust) changes.push(...mergeCustom(existing, cust, policyOf).changes);
      return {
        ...base,
        status: 'update',
        existingId: existing.id,
        existingLabel: `${existing.name}${existing.org ? ` · ${existing.org}` : ''}`,
        changes,
      };
    }
    if (earlier !== undefined)
      return { ...base, status: 'update', existingLabel: `本次导入第 ${earlier} 行`, changes: [] };
    // 手机、微信都对不上但姓名相同：疑似重复，由用户裁决
    const same = ctx.ix.contactsByName(name);
    if (same.length) {
      return {
        ...base,
        status: 'duplicate',
        suspects: same.slice(0, 3).map((c) => ({
          id: c.id,
          label: `${c.name}${c.org ? ` · ${c.org}` : ''}${c.type ? `（${c.type}）` : ''}`,
          score: 1,
        })),
      };
    }
    return { ...base, status: 'new' };
  },

  apply(plan, decision, ctx: ApplyCtx) {
    const out = noResult();
    if (decision === 'skip') return { ...out, skipped: 1 };
    const rec = plan.record;
    const v = rec.values;
    const svc = ctx.d.entity('contact');
    let id: string | undefined;
    let result = out;

    let existingId = plan.existingId;
    if (decision === 'merge' && !existingId) {
      existingId =
        ctx.ix.findContact({
          phone: v.phone,
          wechat: v.wechat,
          name: v.name,
          org: v.org,
          type: v.type,
        })?.id ?? plan.suspects?.[0]?.id;
    }
    if (decision === 'merge') {
      if (!existingId) return { ...out, skipped: 1 };
      const existing = svc.require(existingId);
      const { patch } = mergeFields(existing, v, BASE_KEYS, ctx.policyOf, label);
      const cust = customJson(rec);
      const mc = cust ? mergeCustom(existing, cust, ctx.policyOf) : { custom: undefined };
      if (mc.custom) patch.custom = mc.custom;
      id = existingId;
      if (Object.keys(patch).length) {
        const res = svc.update(ctx.actor, id, patch);
        result = res.status === 'pending' ? { ...out, pending: 1 } : { ...out, updated: 1 };
      } else result = { ...out, skipped: 1 };
    } else {
      const contact: Record<string, unknown> = pick(v, BASE_KEYS);
      const custom = customJson(rec);
      if (custom) contact.custom = custom;
      const res = svc.create(ctx.actor, contact);
      if (res.status !== 'applied') return { ...out, pending: 1 };
      ctx.ix.addContact(res.row);
      id = res.row.id;
      result = { ...out, created: 1 };
    }

    // 关联达人
    const refs = resolveRefs(asArray(v.influencerRef), ctx);
    const primary = v.isPrimary === true;
    for (const infId of refs.ids) ctx.d.influencers.linkContact(ctx.actor, infId, id, primary);
    return result;
  },
};

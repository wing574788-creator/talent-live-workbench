import type { Row } from '../../domain/types.ts';
import { fieldOf } from '../fields.ts';
import { Indexes } from '../indexes.ts';
import type { RowPlan } from '../types.ts';
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

const BASE_KEYS = [
  'mode',
  'stage',
  'followStatus',
  'paymentStatus',
  'slotFeeCents',
  'nextFollowDate',
  'liveDate',
  'liveSlot',
  'linkMethod',
  'lostReason',
  'channel',
  'reportStatus',
];
const label = (k: string) => fieldOf('cooperation', k)?.label ?? k;

/** 通过"达人 + 平台 + 账号 ID"找到达人和他的平台账号；有歧义时不乱选 */
export function resolveInfluencerAccount(
  v: Record<string, unknown>,
  ctx: PlanCtx,
): { infId?: string; account?: Row; error?: string } {
  const platform = asArray(v.platform)[0];
  const ref = str(v.influencerNickname);
  const accountId = str(v.accountId);
  let infId: string | undefined;
  if (accountId && platform) infId = ctx.ix.accountOwner(platform, accountId);
  if (!infId) {
    const r = ctx.ix.resolveInfluencer(ref || accountId, platform);
    if (!r.id) return { error: r.error };
    infId = r.id;
  }
  const accounts = ctx.ix.accountsOf(infId);
  if (!accounts.length) return { infId, error: '该达人还没有平台账号，请先补充账号' };
  let pool = accounts;
  if (accountId)
    pool = pool.filter((a) => String(a.accountId).toLowerCase() === accountId.toLowerCase());
  if (platform) pool = pool.filter((a) => a.platform === platform);
  if (pool.length === 1) return { infId, account: pool[0] };
  if (pool.length === 0)
    return {
      infId,
      error: `该达人没有${platform ? `「${platform}」` : ''}${accountId ? `账号「${accountId}」` : '对应的'}平台账号`,
    };
  return { infId, error: '该达人有多个平台账号，请填写平台或账号 ID 来指定是哪一个' };
}

export const cooperationHandler: Handler = {
  plan(rec, ctx): RowPlan {
    const v = rec.values;
    const issues = [...rec.issues];
    const nickname = str(v.influencerNickname) || str(v.accountId);
    if (!nickname) issues.push({ level: 'error', text: '缺少达人' });
    const stage = str(v.stage) || '待建联';
    if (stage === '洽谈中' && !v.nextFollowDate)
      issues.push({ level: 'error', text: '洽谈中的合作必须有下次跟进日期' });
    if ((stage === '流失' || stage === '放弃') && !str(v.lostReason))
      issues.push({ level: 'error', text: '流失或放弃必须填写原因' });
    const summary = `${nickname || '（无达人）'}${asArray(v.platform)[0] ? ` · ${asArray(v.platform)[0]}` : ''}${v.liveDate ? ` · 开播 ${v.liveDate}` : ''}${v.productStyleNo ? ` · ${v.productStyleNo}` : ''}`;
    const base = basePlan(rec, summary, issues);
    if (hasError(issues)) return { ...base, status: 'error' };

    const res = resolveInfluencerAccount(v, ctx);
    if (res.error || !res.infId || !res.account) {
      return {
        ...base,
        status: 'error',
        issues: [...issues, { level: 'error', text: res.error ?? '找不到达人' }],
      };
    }
    if (str(v.productStyleNo) && !ctx.ix.productByStyle(str(v.productStyleNo))) {
      issues.push({
        level: 'warn',
        text: `商品「${str(v.productStyleNo)}」不存在，没有建立合作商品（请先导入商品）`,
      });
    }
    const key = Indexes.coopKey(res.infId, res.account.id, v.liveDate);
    const existing = ctx.ix.coopByKey(res.infId, res.account.id, v.liveDate);
    const earlier = ctx.seen.get(key);
    if (earlier === undefined) ctx.seen.set(key, rec.rowNo);

    if (existing) {
      const policyOf = (f: string) =>
        ctx.cfg.policy?.fields?.[f] ?? ctx.cfg.policy?.default ?? 'fill';
      const changes = mergeFields(existing, v, BASE_KEYS, policyOf, label).changes;
      const cust = customJson(rec);
      if (cust) changes.push(...mergeCustom(existing, cust, policyOf).changes);
      if (str(v.productStyleNo))
        changes.push({
          field: 'product',
          label: '合作商品',
          before: null,
          after: `${v.productStyleNo}${v.commissionPct != null ? ` 佣金 ${v.commissionPct}%` : ''}`,
        });
      return {
        ...base,
        status: 'update',
        existingId: existing.id,
        existingLabel: `${nickname} · ${existing.stage}`,
        changes,
      };
    }
    if (earlier !== undefined)
      return {
        ...base,
        status: 'update',
        existingLabel: `本次导入第 ${earlier} 行（同一场合作的另一个商品）`,
        changes: [],
      };
    return { ...base, status: 'new' };
  },

  apply(plan, decision, ctx: ApplyCtx) {
    const out = noResult();
    if (decision === 'skip') return { ...out, skipped: 1 };
    const rec = plan.record;
    const v = rec.values;
    const resolved = resolveInfluencerAccount(v, ctx);
    if (!resolved.infId || !resolved.account) throw new Error(resolved.error ?? '找不到达人');
    const svc = ctx.d.entity('cooperation');

    let coop = ctx.ix.coopByKey(resolved.infId, resolved.account.id, v.liveDate);
    let result = out;
    if (coop && decision === 'merge') {
      coop = svc.require(coop.id);
      const { patch } = mergeFields(coop, v, BASE_KEYS, ctx.policyOf, label);
      const cust = customJson(rec);
      const mc = cust ? mergeCustom(coop, cust, ctx.policyOf) : { custom: undefined };
      if (mc.custom) patch.custom = mc.custom;
      if (Object.keys(patch).length) {
        const res = svc.update(ctx.actor, coop.id, patch);
        result = res.status === 'pending' ? { ...out, pending: 1 } : { ...out, updated: 1 };
      } else result = { ...out, skipped: 1 };
    } else if (coop) {
      return { ...out, skipped: 1 };
    } else {
      const payload: Record<string, unknown> = {
        ...pick(v, BASE_KEYS),
        influencerId: resolved.infId,
        platformAccountId: resolved.account.id,
        stage: str(v.stage) || '待建联',
      };
      const custom = customJson(rec);
      if (custom) payload.custom = custom;
      const res = svc.create(ctx.actor, payload);
      if (res.status !== 'applied') return { ...out, pending: 1 };
      coop = res.row;
      ctx.ix.addCoop(res.row);
      result = { ...out, created: 1 };
    }

    // 合作商品：每个商品可以有自己的佣金、直播价、机制
    const styleNo = str(v.productStyleNo);
    const product = styleNo ? ctx.ix.productByStyle(styleNo) : undefined;
    if (product) {
      const cpSvc = ctx.d.entity('cooperation_product');
      const have = cpSvc.findBy('cooperationId', coop.id).find((x) => x.productId === product.id);
      const incoming = {
        commissionPct: v.commissionPct,
        livePriceCents: v.productLivePriceCents,
        mechanism: v.productMechanism,
      };
      if (!have) {
        const created = cpSvc.create(ctx.actor, {
          cooperationId: coop.id,
          productId: product.id,
          ...pick(incoming, ['commissionPct', 'livePriceCents', 'mechanism']),
        });
        if (created.status === 'applied' && result.skipped) result = { ...out, updated: 1 };
      } else {
        const { patch } = mergeFields(
          have,
          incoming,
          ['commissionPct', 'livePriceCents', 'mechanism'],
          ctx.policyOf,
          (k) => k,
        );
        if (Object.keys(patch).length) {
          const res = cpSvc.update(ctx.actor, have.id, patch);
          if (res.status === 'pending') result = { ...result, pending: 1, skipped: 0 };
          else if (result.skipped) result = { ...out, updated: 1 };
        }
      }
    }
    return result;
  },
};

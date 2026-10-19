import { splitMulti } from '../transforms.ts';
import { fieldOf } from '../fields.ts';
import type { Row } from '../../domain/types.ts';
import type { FieldChange, ImportRecord, RowIssue, RowPlan } from '../types.ts';
import {
  asArray,
  basePlan,
  customJson,
  hasError,
  isBlank,
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
  'nickname',
  'realName',
  'categoryTags',
  'styleTags',
  'coopPreference',
  'refCommissionPct',
  'refQuoteCents',
  'rating',
  'blacklistReason',
];
const ACCOUNT_KEYS = [
  'profileUrl',
  'role',
  'followers',
  'avgViews',
  'avgSalesMinCents',
  'avgSalesMaxCents',
  'statsDate',
];
const label = (k: string) => fieldOf('influencer', k)?.label ?? k;
const VIRTUAL = 'virtual:';

interface Pair {
  platform: string;
  accountId: string;
  attrs: Record<string, unknown>;
}

/** 平台和账号 ID 配对："小红书/抖音" + "a/b" 一一对应；其他字段（粉丝数等）归第一个账号 */
function pairAccounts(values: Record<string, unknown>): { pairs: Pair[]; issues: RowIssue[] } {
  const issues: RowIssue[] = [];
  const platforms = asArray(values.platform);
  const ids = isBlank(values.accountId) ? [] : splitMulti(values.accountId);
  const attrs = pick(values, ACCOUNT_KEYS);
  const pairs: Pair[] = [];
  if (!ids.length) {
    if (platforms.length) issues.push({ level: 'warn', text: '有平台但没有账号 ID，账号没有导入' });
    return { pairs, issues };
  }
  if (!platforms.length) {
    issues.push({ level: 'warn', text: '有账号 ID 但没有平台，账号没有导入' });
    return { pairs, issues };
  }
  if (platforms.length === ids.length)
    ids.forEach((id, i) => pairs.push({ platform: platforms[i]!, accountId: id, attrs: {} }));
  else if (platforms.length === 1)
    ids.forEach((id) => pairs.push({ platform: platforms[0]!, accountId: id, attrs: {} }));
  else {
    pairs.push({ platform: platforms[0]!, accountId: ids[0]!, attrs: {} });
    issues.push({
      level: 'warn',
      text: `${platforms.length} 个平台但账号 ID 数量对不上，只导入了「${platforms[0]}」的账号`,
    });
  }
  if (pairs[0]) pairs[0].attrs = attrs;
  return { pairs, issues };
}

/** 对照已有达人，预览合并会改哪些字段 */
function previewMerge(
  existing: Row,
  rec: ImportRecord,
  pairs: Pair[],
  ctx: PlanCtx,
): FieldChange[] {
  const policyOf = (f: string) => ctx.cfg.policy?.fields?.[f] ?? ctx.cfg.policy?.default ?? 'fill';
  const changes = mergeFields(existing, rec.values, BASE_KEYS, policyOf, label).changes;
  const cust = customJson(rec);
  if (cust) changes.push(...mergeCustom(existing, cust, policyOf).changes);
  for (const p of pairs) {
    const acc = ctx.ix
      .accountsOf(existing.id)
      .find(
        (a) =>
          a.platform === p.platform &&
          String(a.accountId).toLowerCase() === p.accountId.toLowerCase(),
      );
    if (!acc)
      changes.push({
        field: 'account',
        label: '平台账号',
        before: null,
        after: `${p.platform} ${p.accountId}`,
      });
    else changes.push(...mergeFields(acc, p.attrs, ACCOUNT_KEYS, policyOf, label).changes);
  }
  return changes;
}

export const influencerHandler: Handler = {
  plan(rec, ctx): RowPlan {
    const v = rec.values;
    const issues = [...rec.issues];
    const nickname = str(v.nickname);
    if (!nickname) issues.push({ level: 'error', text: '缺少昵称' });
    const { pairs, issues: ai } = pairAccounts(v);
    issues.push(...ai);
    const summary = `${nickname || '（无昵称）'}${pairs[0] ? ` · ${pairs[0].platform} ${pairs[0].accountId}` : ''}`;
    const base = basePlan(rec, summary, issues);
    if (hasError(issues)) return { ...base, status: 'error' };

    let existingId: string | undefined;
    for (const p of pairs) {
      const owner = ctx.ix.accountOwner(p.platform, p.accountId);
      if (owner) {
        existingId = owner;
        break;
      }
    }
    const key = pairs[0]
      ? `acc|${pairs[0].platform}|${pairs[0].accountId.toLowerCase()}`
      : `nick|${nickname.toLowerCase()}`;
    const earlier = ctx.seen.get(key);
    if (earlier === undefined) ctx.seen.set(key, rec.rowNo);

    if (existingId?.startsWith(VIRTUAL)) {
      // 命中的是本次导入里前面某一行"将要新建"的达人
      return {
        ...base,
        status: 'update',
        existingLabel: `本次导入第 ${earlier ?? '?'} 行`,
        changes: [],
      };
    }
    if (existingId) {
      const existing = ctx.ix.influencer(existingId)!;
      return {
        ...base,
        status: 'update',
        existingId,
        existingLabel: String(existing.nickname),
        changes: previewMerge(existing, rec, pairs, ctx),
      };
    }
    if (earlier !== undefined) {
      return { ...base, status: 'update', existingLabel: `本次导入第 ${earlier} 行`, changes: [] };
    }
    const suspects = ctx.ix.similarInfluencers(nickname);
    if (suspects.length) return { ...base, status: 'duplicate', suspects };
    return { ...base, status: 'new' };
  },

  register(plan, ix) {
    const v = plan.record.values;
    const id = `virtual:influencer:${plan.rowNo}`;
    ix.addInfluencer({ id, version: 1, nickname: str(v.nickname) });
    for (const p of pairAccounts(v).pairs) {
      ix.addAccount({
        id: `virtual:account:${plan.rowNo}:${p.accountId}`,
        version: 1,
        influencerId: id,
        platform: p.platform,
        accountId: p.accountId,
      });
    }
  },

  apply(plan, decision, ctx: ApplyCtx) {
    const out = noResult();
    if (decision === 'skip') return { ...out, skipped: 1 };
    const rec = plan.record;
    const v = rec.values;
    const { pairs } = pairAccounts(v);

    let existingId = plan.existingId?.startsWith(VIRTUAL) ? undefined : plan.existingId;
    if (decision === 'merge' && !existingId) {
      // 文件内重复或疑似重复选了合并：重新对照一次（前面的行这时已经真的建好了）
      for (const p of pairs) existingId ??= ctx.ix.accountOwner(p.platform, p.accountId);
      const suspect = plan.suspects?.[0];
      existingId ??=
        suspect && !suspect.id.startsWith(VIRTUAL)
          ? suspect.id
          : suspect
            ? ctx.ix.influencersByNickname(suspect.label)[0]
            : undefined;
      existingId ??= ctx.ix.influencersByNickname(str(v.nickname))[0];
    }
    if (decision === 'merge' && existingId) return mergeInto(existingId, plan, pairs, ctx);
    if (decision === 'merge') return { ...out, skipped: 1 };

    // 新建
    const influencer: Record<string, unknown> = { ...pick(v, BASE_KEYS) };
    const custom = customJson(rec);
    if (custom) influencer.custom = custom;
    const accounts = pairs.map((p) => ({
      platform: p.platform,
      accountId: p.accountId,
      ...p.attrs,
    }));
    const res = ctx.d.influencers.createWithAccounts(ctx.actor, { influencer, accounts });
    ctx.ix.addInfluencer(res.influencer);
    res.accounts.forEach((a) => ctx.ix.addAccount(a));
    return { ...out, created: 1 };
  },
};

function mergeInto(id: string, plan: RowPlan, pairs: Pair[], ctx: ApplyCtx) {
  const rec = plan.record;
  const svc = ctx.d.entity('influencer');
  const existing = svc.require(id);
  let applied = 0;
  let pending = 0;
  const note = (r: { status: string }) => (r.status === 'pending' ? pending++ : applied++);

  const { patch } = mergeFields(existing, rec.values, BASE_KEYS, ctx.policyOf, label);
  const cust = customJson(rec);
  const mc = cust ? mergeCustom(existing, cust, ctx.policyOf) : { custom: undefined };
  if (mc.custom) patch.custom = mc.custom;
  if (Object.keys(patch).length) note(svc.update(ctx.actor, id, patch));

  for (const p of pairs) {
    const acc = ctx.ix
      .accountsOf(id)
      .find(
        (a) =>
          a.platform === p.platform &&
          String(a.accountId).toLowerCase() === p.accountId.toLowerCase(),
      );
    if (!acc) {
      const res = ctx.d.entity('platform_account').create(ctx.actor, {
        influencerId: id,
        platform: p.platform,
        accountId: p.accountId,
        ...p.attrs,
      });
      if (res.status === 'applied') ctx.ix.addAccount(res.row);
      note(res);
    } else {
      const { patch: ap } = mergeFields(acc, p.attrs, ACCOUNT_KEYS, ctx.policyOf, label);
      if (Object.keys(ap).length)
        note(ctx.d.entity('platform_account').update(ctx.actor, acc.id, ap));
    }
  }
  // 一个达人只计一次：有改动落库算更新，有改动进了审核队列算待审核，都没有算跳过（没有变化）
  return {
    created: 0,
    updated: applied ? 1 : 0,
    pending: pending ? 1 : 0,
    skipped: applied || pending ? 0 : 1,
  };
}

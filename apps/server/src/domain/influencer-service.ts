/* eslint-disable @typescript-eslint/no-explicit-any */
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { platformAccounts, type pendingChanges } from '../db/schema.ts';
import { DomainError, conflict } from './errors.ts';
import { EntityService, newId, type QueryOptions } from './entity-service.ts';
import type { Actor, Row, WriteResult } from './types.ts';

/** 昵称归一：小写、去空白和常见符号，便于比较"疑似重复"。 */
export function normalizeNickname(s: string): string {
  return s.toLowerCase().replace(/[\s·.\-_~!！?？、,，。:：@#*()（）[\]【】]/g, '');
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  if (s.length < 2) out.add(s);
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/** 昵称相似度（Dice 系数 0~1；一方包含另一方至少 2 个字符时直接判高相似）。 */
export function nicknameSimilarity(a: string, b: string): number {
  const x = normalizeNickname(a);
  const y = normalizeNickname(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (Math.min(x.length, y.length) >= 2 && (x.includes(y) || y.includes(x))) return 0.85;
  const bx = bigrams(x);
  const by = bigrams(y);
  let inter = 0;
  for (const g of bx) if (by.has(g)) inter++;
  return (2 * inter) / (bx.size + by.size);
}

const SIMILAR_THRESHOLD = 0.7;

/** 合并时需要改归属的子表：实体名 → 指向达人的列 */
const CHILD_TABLES: [string, string][] = [
  ['platform_account', 'influencerId'],
  ['cooperation', 'influencerId'],
  ['follow_up', 'influencerId'],
  ['sample_shipment', 'influencerId'],
  ['sample_return', 'influencerId'],
  ['sample_writeoff', 'influencerId'],
  ['influencer_address', 'influencerId'],
];

export class InfluencerService extends EntityService {
  /** 查重：账号强唯一键精确命中 + 昵称相似提示（绝不自动合并）。 */
  checkDuplicate(input: { platform?: string; accountId?: string; nickname?: string }) {
    let exact: { account: Row; influencer: Row } | null = null;
    if (input.platform && input.accountId) {
      const account = this.db
        .select()
        .from(platformAccounts)
        .where(
          and(
            eq(platformAccounts.platform, input.platform),
            eq(platformAccounts.accountId, input.accountId.trim()),
            isNull(platformAccounts.deletedAt),
          ),
        )
        .get() as Row | undefined;
      if (account) {
        const influencer = this.get(account.influencerId as string);
        if (influencer) exact = { account, influencer };
      }
    }
    const similar: { influencer: Row; score: number }[] = [];
    if (input.nickname?.trim()) {
      for (const inf of this.list()) {
        if (exact && inf.id === exact.influencer.id) continue;
        const score = nicknameSimilarity(input.nickname, inf.nickname as string);
        if (score >= SIMILAR_THRESHOLD) similar.push({ influencer: inf, score });
      }
      similar.sort((a, b) => b.score - a.score);
    }
    return { exact, similar };
  }

  /** 新建达人并同时建账号：账号重复整体失败（事务回滚），日志共用一个批次号。 */
  createWithAccounts(
    actor: Actor,
    input: { influencer: unknown; accounts?: unknown[] },
  ): { influencer: Row; accounts: Row[]; batchId: string } {
    const batchId = actor.batchId ?? newId();
    const act = { ...actor, batchId };
    return this.tx(() => {
      const inf = this.createApplied(act, input.influencer);
      const accountSvc = this.registry.get('platform_account');
      const accounts = (input.accounts ?? []).map((a) => {
        const res = accountSvc.create(act, { ...(a as object), influencerId: inf.id });
        return (res as { row: Row }).row;
      });
      return { influencer: inf, accounts, batchId };
    });
  }

  private createApplied(actor: Actor, input: unknown): Row {
    const res = this.create(actor, input);
    if (res.status !== 'applied') throw new DomainError('invalid_state', '新建达人不应进入审核');
    return res.row;
  }

  /** 列表：关键字同时匹配昵称和账号 ID；附带账号摘要和合作数。 */
  listWithSummary(opts: QueryOptions & { platform?: string }) {
    const q = opts.q?.trim();
    const like = q ? `%${q.replace(/[%_\\]/g, (c) => '\\' + c)}%` : undefined;
    const clauses = [];
    if (like) {
      clauses.push(
        or(
          sql`${this.cols.nickname} like ${like} escape '\\'`,
          sql`${this.cols.id} in (select influencer_id from platform_accounts where account_id like ${like} escape '\\' and deleted_at is null)`,
        ),
      );
    }
    if (opts.platform) {
      clauses.push(
        sql`${this.cols.id} in (select influencer_id from platform_accounts where platform = ${opts.platform} and deleted_at is null)`,
      );
    }
    const { rows, total } = this.query({ ...opts, q: undefined }, and(...clauses));
    const ids = rows.map((r) => r.id);
    const accounts = ids.length
      ? this.db
          .select()
          .from(platformAccounts)
          .where(
            and(inArray(platformAccounts.influencerId, ids), isNull(platformAccounts.deletedAt)),
          )
          .all()
      : [];
    const coopCounts = new Map<string, number>();
    for (const c of this.registry.get('cooperation').list()) {
      const k = c.influencerId as string;
      coopCounts.set(k, (coopCounts.get(k) ?? 0) + 1);
    }
    return {
      total,
      rows: rows.map((r) => ({
        ...r,
        accounts: accounts.filter((a) => a.influencerId === r.id),
        coopCount: coopCounts.get(r.id) ?? 0,
      })),
    };
  }

  /** 关联联系人；设为主要对接人时，同一达人的其他关联自动取消主要。 */
  linkContact(actor: Actor, influencerId: string, contactId: string, isPrimary = false): Row {
    this.require(influencerId);
    this.registry.get('contact').require(contactId);
    const links = this.registry.get('influencer_contact');
    return this.tx(() => {
      const mine = links.findBy('influencerId', influencerId);
      let link = mine.find((l) => l.contactId === contactId);
      if (isPrimary) {
        for (const o of mine) {
          if (o.id !== link?.id && o.isPrimary) links.update(actor, o.id, { isPrimary: false });
        }
      }
      if (link) {
        links.update(actor, link.id, { isPrimary });
        link = links.require(link.id);
      } else {
        link = (links.create(actor, { influencerId, contactId, isPrimary }) as { row: Row }).row;
      }
      return link;
    });
  }

  // ───────────── 合并（走审核队列） ─────────────
  /** 合并达人属于敏感操作：无论谁发起都只生成待审核记录（DEV_PLAN 阶段 2）。 */
  requestMerge(actor: Actor, keepId: string, mergeId: string): WriteResult {
    if (keepId === mergeId) throw new DomainError('validation', '不能把达人合并到自己');
    const keep = this.require(keepId);
    const merge = this.require(mergeId);
    return this.tx(() =>
      this.queue(
        actor,
        'merge',
        keep,
        { mergeId, mergeVersion: merge.version, mergeNickname: merge.nickname },
        '合并达人',
      ),
    );
  }

  override applyApproved(
    pending: typeof pendingChanges.$inferSelect,
    reviewerId: string,
  ): WriteResult {
    if (pending.action !== 'merge') return super.applyApproved(pending, reviewerId);
    const keep = this.require(pending.entityId);
    const patch = pending.patch as { mergeId: string; mergeVersion: number };
    const merged = this.require(patch.mergeId);
    if (keep.version !== pending.baseVersion || merged.version !== patch.mergeVersion) {
      throw conflict('合并涉及的达人在提出后已被修改，需要重新确认');
    }
    // 子记录的移动与删除共用一个批次号（= 待审核记录 id），之后可以整批撤销
    const actor: Actor = {
      type: 'user',
      userId: reviewerId,
      batchId: pending.id,
      source: `合并达人：${merged.nickname} → ${keep.nickname}`,
    };
    for (const [entity, field] of CHILD_TABLES) {
      const svc = this.registry.get(entity);
      for (const row of svc.findBy(field, merged.id))
        svc.update(actor, row.id, { [field]: keep.id });
    }
    const links = this.registry.get('influencer_contact');
    const keepLinks = new Set(links.findBy('influencerId', keep.id).map((l) => l.contactId));
    for (const l of links.findBy('influencerId', merged.id)) {
      if (keepLinks.has(l.contactId as string)) links.delete(actor, l.id);
      else links.update(actor, l.id, { influencerId: keep.id, isPrimary: false });
    }
    const fill: Record<string, unknown> = {};
    for (const f of [
      'realName',
      'coopPreference',
      'refCommissionPct',
      'refQuoteCents',
      'refUpdatedAt',
      'refSource',
      'rating',
      'blacklistReason',
    ]) {
      if ((keep[f] == null || keep[f] === '') && merged[f] != null) fill[f] = merged[f];
    }
    fill.categoryTags = [
      ...new Set([
        ...((keep.categoryTags as string[]) ?? []),
        ...((merged.categoryTags as string[]) ?? []),
      ]),
    ];
    fill.styleTags = [
      ...new Set([
        ...((keep.styleTags as string[]) ?? []),
        ...((merged.styleTags as string[]) ?? []),
      ]),
    ];
    fill.recycleIssueCount =
      ((keep.recycleIssueCount as number) ?? 0) + ((merged.recycleIssueCount as number) ?? 0);
    const keepNow = this.require(keep.id);
    this.applyUpdate(actor, keepNow, fill, reviewerId);
    return this.applyDelete(actor, this.require(merged.id), reviewerId);
  }
}

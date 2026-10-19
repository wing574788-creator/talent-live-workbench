/**
 * Agent 的领域工具（PRD 7.2）。工具只调用领域服务，不写 SQL；不提供 SQL、命令和文件读写。
 *  - 只读：查询结果先按外发规则过滤（OutboundGuard.project），再返回给模型。
 *  - 低风险写：新增跟进、草稿合作、寄样草稿——直接写入，卡片上可撤销。
 *  - 敏感写：改字段、改金额佣金、改阶段、合并、删除、批量——只生成待审核记录。
 * 护栏（目标确认、一个合作、日期/金额/佣金核对）在 AiRun 里。
 */
import { COOP_STAGES, FOLLOW_METHODS, INTENTS } from '@workbench/shared';
import { Type, type DomainTool } from '../agent/adapter.ts';
import { DomainError } from '../domain/errors.ts';
import { keyTotals } from '../domain/sample-ledger.ts';
import { MAX_BATCH, type Row } from '../domain/types.ts';
import { currentTime, resolveDate } from './dates.ts';
import { AiRun } from './run.ts';

const lit = <T extends string>(vals: readonly T[]) => Type.Union(vals.map((v) => Type.Literal(v)));
const optStr = (description: string) => Type.Optional(Type.String({ description }));

/** 模型能改的字段白名单。手机号、微信号、地址、真实姓名永远不在里面：那些只能用户手动填。 */
const PATCHABLE = {
  influencer: [
    'nickname',
    'categoryTags',
    'styleTags',
    'coopPreference',
    'refCommissionPct',
    'refQuoteCents',
    'rating',
    'blacklistReason',
  ],
  cooperation: [
    'mode',
    'followStatus',
    'paymentStatus',
    'slotFeeCents',
    'liveDate',
    'liveSlot',
    'linkMethod',
    'nextFollowDate',
    'lostReason',
    'channel',
    'reportStatus',
  ],
  cooperation_product: ['commissionPct', 'livePriceCents', 'mechanism'],
  product: [
    'name',
    'status',
    'dailyPriceCents',
    'livePriceCents',
    'finalPriceCents',
    'price1111Cents',
    'price618Cents',
    'mechanism',
    'sellingPoints',
  ],
  contact: ['name', 'type', 'org', 'nextFollowDate'],
} as const;
type PatchEntity = keyof typeof PATCHABLE;
const PATCH_ENTITIES = Object.keys(PATCHABLE) as PatchEntity[];
const PCT_FIELDS = new Set(['commissionPct', 'refCommissionPct']);
const DATE_FIELDS = new Set(['liveDate', 'nextFollowDate']);
const isMoneyField = (f: string) => f.endsWith('Cents');

const fmtCents = (c: number) =>
  `¥${(c / 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;

export function buildTools(run: AiRun): DomainTool[] {
  const { d, guard } = run;
  const nick = (r: Row) =>
    (guard.project('influencer', r).nickname as string | undefined) ?? '[已隐藏]';
  const label = (type: string, r: Row): string => {
    if (type === 'influencer') return nick(r);
    if (type === 'cooperation') {
      const inf = d.entity('influencer').peek(r.influencerId as string);
      return `${inf ? nick(inf) : '（已删除）'} · ${r.stage}`;
    }
    return guard.sanitize(d.reviewView.displayName(type, r));
  };
  const ref = (type: string, r: Row) => ({
    type,
    id: r.id,
    label: label(type, r),
    link: `wb:${type}:${r.id}`,
  });
  const cap = (n: unknown, max = 20, dflt = 10) => Math.min(Math.max(Number(n) || dflt, 1), max);

  const tools: DomainTool[] = [];
  const add = (t: DomainTool) => tools.push(t);

  // ═════════════ 辅助 ═════════════
  add({
    name: 'get_current_time',
    label: '获取当前时间',
    description:
      '获取当前日期和时间（北京时间 Asia/Shanghai）。需要知道"今天"是哪天时调用，不要自己猜。',
    parameters: Type.Object({}),
    execute: async () => currentTime(run.now),
  });
  add({
    name: 'resolve_date',
    label: '解析日期',
    description:
      '把用户说的日期（"下周三""月底""10月21日""三天后"）解析成绝对日期。相对日期一律由这个工具计算，你不要自己算。',
    parameters: Type.Object({
      text: Type.String({ description: '用户原话里的日期说法，原样填入' }),
    }),
    execute: async (p) => {
      const r = resolveDate(String(p.text), run.now);
      if (!r) throw new DomainError('validation', `无法解析「${p.text}」，请向用户确认具体日期。`);
      return r;
    },
  });

  // ═════════════ 只读：搜索 ═════════════
  add({
    name: 'find_influencers',
    label: '搜索达人',
    description:
      '按昵称或账号 ID 搜索达人。返回候选列表；matches>1 说明有多个候选，这时不能替用户选，要调用 ask_user_to_choose。',
    parameters: Type.Object({
      query: optStr('昵称或账号 ID 的一部分'),
      platform: Type.Optional(lit(['小红书', '抖音', '视频号'])),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }),
    execute: async (p) => {
      guard.assertModule('influencer');
      const res = d.influencers.listWithSummary({
        q: p.query,
        platform: p.platform,
        limit: cap(p.limit),
      });
      run.noteMatches(
        res.rows.map((r) => r.id),
        res.total,
      );
      return {
        matches: res.total,
        rows: res.rows.map((r) => ({
          ...guard.project('influencer', r, { coopCount: r.coopCount }),
          ref: ref('influencer', r),
          accounts: r.accounts.map((a) => ({ id: a.id, ...guard.project('influencer', a) })),
        })),
        note:
          res.total > res.rows.length
            ? `只显示前 ${res.rows.length} 条，请缩小搜索范围`
            : undefined,
      };
    },
  });

  add({
    name: 'find_cooperations',
    label: '搜索合作',
    description:
      '查询合作。可按达人、阶段筛选。一个达人有多个进行中的合作时，不能替用户选，要让用户选。',
    parameters: Type.Object({
      influencerId: optStr('达人 ID'),
      stage: Type.Optional(lit(COOP_STAGES)),
      query: optStr('达人昵称或账号 ID 的一部分'),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }),
    execute: async (p) => {
      guard.assertModule('cooperation');
      const filters: Record<string, string> = {};
      if (p.influencerId) filters.influencerId = p.influencerId;
      if (p.stage) filters.stage = p.stage;
      const res = d.cooperations.listEnriched({
        q: p.query,
        filters,
        limit: cap(p.limit),
        sort: 'updatedAt',
        dir: 'desc',
      });
      run.noteMatches(
        res.rows.map((r) => r.id),
        res.total,
      );
      return {
        matches: res.total,
        rows: res.rows.map((r) => ({
          ...guard.project('cooperation', r),
          ref: ref('cooperation', r),
          influencer:
            guard.project('influencer', {
              id: (r as unknown as Row).influencerId,
              nickname: r.influencerNickname,
            } as unknown as Row).nickname ?? '[已隐藏]',
          platform: r.platform,
          products: r.productNames,
          commissionRange:
            r.commissionMin == null
              ? null
              : r.commissionMin === r.commissionMax
                ? `${r.commissionMin}%`
                : `${r.commissionMin}%~${r.commissionMax}%`,
        })),
      };
    },
  });

  add({
    name: 'find_products',
    label: '搜索商品',
    description: '按款号或名称搜索商品，返回颜色、尺码。',
    parameters: Type.Object({
      query: Type.String({ description: '款号或名称的一部分' }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }),
    execute: async (p) => {
      guard.assertModule('product');
      const res = d.entity('product').query({ q: p.query, limit: cap(p.limit) });
      run.noteMatches(
        res.rows.map((r) => r.id),
        res.total,
      );
      return {
        matches: res.total,
        rows: res.rows.map((r) => {
          const variants = d.entity('product_variant').findBy('productId', r.id);
          return {
            ...guard.project('product', r),
            ref: ref('product', r),
            colors: [...new Set(variants.map((v) => v.color))],
            sizes: [...new Set(variants.map((v) => v.size))],
          };
        }),
      };
    },
  });

  add({
    name: 'find_contacts',
    label: '搜索联系人',
    description: '按姓名或所属机构（如 MCN 名称）搜索联系人。不会返回手机号和微信号。',
    parameters: Type.Object({
      query: Type.String({ description: '姓名或机构名的一部分' }),
      type: Type.Optional(lit(['达人本人', 'MCN', '经纪人', '私人商务'])),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }),
    execute: async (p) => {
      guard.assertModule('contact');
      const res = d
        .entity('contact')
        .query({ q: p.query, filters: p.type ? { type: p.type } : {}, limit: cap(p.limit) });
      run.noteMatches(
        res.rows.map((r) => r.id),
        res.total,
      );
      return {
        matches: res.total,
        rows: res.rows.map((r) => ({
          ...guard.project('contact', r),
          ref: ref('contact', r),
          influencers: guard.moduleAllowed('influencer')
            ? d
                .entity('influencer_contact')
                .findBy('contactId', r.id)
                .map((l) => d.entity('influencer').peek(l.influencerId as string))
                .filter(Boolean)
                .map((i) => ({ nickname: nick(i!), ref: ref('influencer', i!) }))
            : undefined,
        })),
      };
    },
  });

  // ═════════════ 只读：详情 ═════════════
  add({
    name: 'get_influencer',
    label: '查看达人',
    description: '查看一个达人的资料、平台账号、对接的联系人、合作概况、最近跟进和样衣在外情况。',
    parameters: Type.Object({ id: Type.String() }),
    execute: async (p) => {
      guard.assertModule('influencer');
      const inf = d.entity('influencer').require(p.id);
      const accounts = d.entity('platform_account').findBy('influencerId', inf.id);
      const coops = guard.moduleAllowed('cooperation')
        ? d.entity('cooperation').findBy('influencerId', inf.id)
        : [];
      if (coops.length) run.noteMatches(coops.map((c) => c.id));
      return {
        ...guard.project('influencer', inf),
        ref: ref('influencer', inf),
        accounts: accounts.map((a) => ({
          id: a.id,
          role: a.role,
          ...guard.project('influencer', a),
        })),
        contacts: guard.moduleAllowed('contact')
          ? d
              .entity('influencer_contact')
              .findBy('influencerId', inf.id)
              .map((l) => d.entity('contact').peek(l.contactId as string))
              .filter(Boolean)
              .map((c) => ({
                ...guard.project('contact', c!),
                ref: ref('contact', c!),
                primary: undefined,
              }))
          : '（外发设置不允许发送联系人数据）',
        cooperations: coops.map((c) => ({
          ...guard.project('cooperation', c),
          ref: ref('cooperation', c),
        })),
        recentFollowUps: guard.moduleAllowed('follow_up')
          ? d
              .entity('follow_up')
              .findBy('influencerId', inf.id)
              .concat(coops.flatMap((c) => d.entity('follow_up').findBy('cooperationId', c.id)))
              .sort((a, b) => String(b.occurredAt).localeCompare(String(a.occurredAt)))
              .slice(0, 5)
              .map((f) => guard.project('follow_up', f))
          : undefined,
        samplesOutstanding: guard.moduleAllowed('shipment')
          ? keyTotals(d.registry, inf.id)
              .filter((t) => t.outstanding > 0)
              .map((t) => `${t.styleNo} ${t.productName} ${t.color} ${t.size} ×${t.outstanding}`)
          : undefined,
      };
    },
  });

  add({
    name: 'get_cooperation',
    label: '查看合作',
    description: '查看一个合作的阶段、合作商品（含每个商品的佣金）、跟进记录。',
    parameters: Type.Object({ id: Type.String() }),
    execute: async (p) => {
      guard.assertModule('cooperation');
      const detail = d.cooperations.detail(p.id);
      const c = detail.cooperation;
      const inf = detail.influencer;
      return {
        ...guard.project('cooperation', c),
        ref: ref('cooperation', c),
        influencer: inf ? { nickname: nick(inf), ref: ref('influencer', inf) } : null,
        products: detail.products.map((x) => {
          const cp = x as unknown as Row & { product?: Row };
          return {
            id: cp.id,
            commissionPct: cp.commissionPct,
            livePriceCents: cp.livePriceCents,
            product: cp.product
              ? {
                  ...guard.project('product', cp.product as Row),
                  ref: ref('product', cp.product as Row),
                }
              : null,
          };
        }),
        followUps: guard.moduleAllowed('follow_up')
          ? detail.followUps.slice(0, 10).map((f) => guard.project('follow_up', f))
          : undefined,
      };
    },
  });

  add({
    name: 'get_product',
    label: '查看商品',
    description: '查看商品详情：价格、机制、卖点、颜色尺码。',
    parameters: Type.Object({ id: Type.String() }),
    execute: async (p) => {
      guard.assertModule('product');
      const pr = d.entity('product').require(p.id);
      const variants = d.entity('product_variant').findBy('productId', pr.id);
      return {
        ...guard.project('product', pr),
        ref: ref('product', pr),
        variants: variants.map((v) => ({ color: v.color, size: v.size })),
      };
    },
  });

  add({
    name: 'get_sample_balance',
    label: '查看达人样衣',
    description:
      '查看某个达人的样衣台账：按款号+款名+颜色+尺码的累计寄出、退回、核销和在外数量，以及应寄回日期。',
    parameters: Type.Object({ influencerId: Type.String() }),
    execute: async (p) => {
      guard.assertModule('shipment');
      const inf = d.entity('influencer').require(p.influencerId);
      return {
        influencer: ref('influencer', inf),
        lines: keyTotals(d.registry, inf.id).map((t) => ({
          styleNo: t.styleNo,
          productName: t.productName,
          color: t.color,
          size: t.size,
          shipped: t.shipped,
          returned: t.returned,
          writtenOff: t.writtenOff,
          outstanding: t.outstanding,
          dueBackDate: t.dueBackDate,
        })),
      };
    },
  });

  // ═════════════ 只读：统计 ═════════════
  add({
    name: 'run_stats',
    label: '统计查询',
    description:
      '预定义的统计查询。name 可选：signed_not_live（样衣已签收超过 minDays 天、合作还没开播的达人）、overdue_samples（逾期未寄回样衣的达人）、outstanding_samples（样衣还在外的达人）、due_follow_ups（今天及之前该跟进的合作和联系人）、upcoming_lives（未来 days 天内开播）、stage_counts（各阶段合作数量）、influencers_of_org（某机构/MCN 名下的达人，org 为机构名）。',
    parameters: Type.Object({
      name: lit([
        'signed_not_live',
        'overdue_samples',
        'outstanding_samples',
        'due_follow_ups',
        'upcoming_lives',
        'stage_counts',
        'influencers_of_org',
      ]),
      minDays: Type.Optional(Type.Integer({ minimum: 0, maximum: 365 })),
      days: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
      org: optStr('机构名'),
    }),
    execute: async (p) => {
      const today = run.today();
      const inf = (id: string) => d.entity('influencer').peek(id);
      const person = (id: string, name: string) => {
        const r = inf(id);
        return r ? { nickname: nick(r), ref: ref('influencer', r) } : { nickname: name };
      };
      switch (p.name) {
        case 'signed_not_live': {
          guard.assertModule('shipment');
          guard.assertModule('cooperation');
          const min = p.minDays ?? d.settings.get('signedNotLiveDays');
          const rows = d.home.signedNotLive(min, today);
          return {
            minDays: min,
            count: rows.length,
            rows: rows.map((r) => ({
              ...person(r.influencerId, r.nickname),
              outstanding: r.outstanding,
              signedAt: r.signedAt,
              days: r.days,
              scheduled: r.scheduled,
            })),
          };
        }
        case 'overdue_samples':
        case 'outstanding_samples': {
          guard.assertModule('shipment');
          const rows = d.samples
            .summaries(today)
            .filter((s) => (p.name === 'overdue_samples' ? s.overdueQty > 0 : s.outstanding > 0));
          return {
            count: rows.length,
            rows: rows.slice(0, 50).map((s) => ({
              ...person(s.influencer.id, String(s.influencer.nickname)),
              outstanding: s.outstanding,
              overdueQty: s.overdueQty,
            })),
          };
        }
        case 'due_follow_ups': {
          guard.assertModule('cooperation');
          const rows = d.home.dueFollows(today);
          return {
            count: rows.length,
            rows: rows.slice(0, 50).map((r) => ({
              kind: r.kind,
              name: r.kind === 'cooperation' ? r.name : guard.sanitize(r.name),
              stage: r.stage,
              nextFollowDate: r.nextFollowDate,
              overdueDays: r.overdueDays,
              nextAction: r.nextAction,
              link: `wb:${r.kind}:${r.id}`,
            })),
          };
        }
        case 'upcoming_lives': {
          guard.assertModule('cooperation');
          const rows = d.home.upcomingLives(today, p.days ?? 7);
          return {
            count: rows.length,
            rows: rows.map((r) => ({
              influencer: r.influencerNickname,
              liveDate: r.liveDate,
              liveSlot: r.liveSlot,
              stage: r.stage,
              commissionUnconfirmed: r.commissionUnconfirmed,
              linkMissing: r.linkMissing,
              link: `wb:cooperation:${r.cooperationId}`,
            })),
          };
        }
        case 'stage_counts': {
          guard.assertModule('cooperation');
          const counts: Record<string, number> = {};
          for (const c of d.entity('cooperation').list())
            counts[c.stage as string] = (counts[c.stage as string] ?? 0) + 1;
          return counts;
        }
        case 'influencers_of_org': {
          guard.assertModule('contact');
          guard.assertModule('influencer');
          if (!p.org?.trim()) throw new DomainError('validation', '请提供机构名 org');
          const contacts = d
            .entity('contact')
            .query({ q: p.org, limit: 50 })
            .rows.filter(
              (c) => String(c.org ?? '').includes(p.org!) || String(c.name).includes(p.org!),
            );
          const seen = new Map<string, Row>();
          for (const c of contacts)
            for (const l of d.entity('influencer_contact').findBy('contactId', c.id)) {
              const i = inf(l.influencerId as string);
              if (i) seen.set(i.id, i);
            }
          return {
            org: p.org,
            contacts: contacts.map((c) => ({
              ...guard.project('contact', c),
              ref: ref('contact', c),
            })),
            count: seen.size,
            influencers: [...seen.values()].map((i) => ({
              nickname: nick(i),
              ref: ref('influencer', i),
            })),
          };
        }
      }
    },
  });

  // ═════════════ 让用户选择 ═════════════
  add({
    name: 'ask_user_to_choose',
    label: '请用户选择',
    description:
      '名字匹配到多个候选（或不确定是哪一条）时，把候选展示给用户，由用户点选。调用后本轮不要再写入，用一句话告诉用户请在卡片里选择即可。',
    parameters: Type.Object({
      question: Type.String({ description: '给用户看的一句话问题' }),
      entity: lit(['influencer', 'cooperation', 'contact', 'product']),
      ids: Type.Array(Type.String(), { minItems: 2, maxItems: 8 }),
    }),
    execute: async (p) => {
      const svc = d.entity(p.entity);
      const candidates = p.ids.map((id: string) => {
        const r = svc.require(id);
        if (!run.isConfirmed(id)) run.noteMatches([id], p.ids.length);
        let detail: string | undefined;
        if (p.entity === 'influencer') {
          const a = d.entity('platform_account').findBy('influencerId', id);
          detail = a.map((x) => `${x.platform} ${x.accountId}`).join('、');
        } else if (p.entity === 'cooperation') {
          detail = [r.stage, r.liveDate && `开播 ${r.liveDate}`].filter(Boolean).join(' · ');
        }
        return {
          id,
          type: p.entity as string,
          label: label(p.entity, r),
          detail: detail ? guard.sanitize(detail) : undefined,
        };
      });
      run.awaitingChoice = true;
      run.emit({ kind: 'choose', title: p.question, question: p.question, candidates });
      return { ok: true, note: '候选已展示给用户。本轮不要再写入，请用一句话请用户在卡片里选择。' };
    },
  });

  // ═════════════ 低风险写：直接写入，可撤销 ═════════════
  add({
    name: 'add_follow_up',
    label: '新增跟进记录',
    description:
      '记一条跟进。目标是合作（cooperationId）、达人（influencerId）或联系人（contactId）之一。下次跟进日期用 nextFollowDateText 填用户原话里的日期说法（如"下周三"），由程序解析，不要自己算日期。目标有多个同名候选时先用 ask_user_to_choose。',
    parameters: Type.Object({
      cooperationId: optStr('合作 ID'),
      influencerId: optStr('达人 ID（没有具体合作时）'),
      contactId: optStr('联系人 ID'),
      method: lit(FOLLOW_METHODS),
      summary: Type.String({ description: '内容摘要：聊了什么、对方怎么说' }),
      intent: Type.Optional(lit(INTENTS)),
      followStatus: optStr('洽谈中的跟进状态，如 待回复、报价中'),
      nextAction: optStr('下一步要做什么'),
      nextFollowDateText: optStr('下次跟进日期，原话里的说法'),
    }),
    execute: async (p) => {
      if (!p.cooperationId && !p.influencerId && !p.contactId)
        throw new DomainError('validation', '请指定 cooperationId、influencerId 或 contactId 之一');
      let coop: Row | undefined;
      let influencerId: string | null = null;
      if (p.cooperationId) {
        coop = d.entity('cooperation').require(p.cooperationId);
        run.assertTarget('cooperation', coop.id, label('cooperation', coop));
        run.lockCooperation(coop.id, label('cooperation', coop));
        influencerId = coop.influencerId as string;
      } else if (p.influencerId) {
        const i = d.entity('influencer').require(p.influencerId);
        run.assertTarget('influencer', i.id, nick(i));
        influencerId = i.id;
      }
      if (p.contactId) {
        const c = d.entity('contact').require(p.contactId);
        run.assertTarget('contact', c.id, label('contact', c));
      }
      const next = p.nextFollowDateText ? run.date(p.nextFollowDateText) : null;
      if (coop?.stage === '洽谈中' && !coop.nextFollowDate && !next) {
        throw new DomainError(
          'validation',
          '洽谈中的合作需要下次跟进日期。用户原话里有日期就用 nextFollowDateText 填；没有就请用户补充。',
        );
      }
      const opts = d.settings.followStatuses();
      if (p.followStatus && !opts.includes(p.followStatus))
        throw new DomainError('validation', `跟进状态只能是：${opts.join('、')}`);
      run.assertNoPlaceholders([p.summary, p.nextAction]);
      const res = d.entity('follow_up').create(run.actor(), {
        occurredAt: run.now.toISOString(),
        method: p.method,
        cooperationId: p.cooperationId ?? null,
        influencerId: p.cooperationId ? null : (p.influencerId ?? null),
        contactId: p.contactId ?? null,
        summary: p.summary,
        intent: p.intent ?? null,
        followStatus: p.followStatus ?? null,
        nextAction: p.nextAction ?? null,
        nextFollowDate: next?.date ?? null,
        sourceText: run.originalText,
        sourceAttachmentId: run.sourceAttachmentId,
      });
      if (res.status !== 'applied') throw new DomainError('invalid_state', '新增跟进不应进入审核');
      run.emit({
        kind: 'applied',
        entity: 'follow_up',
        entityId: res.row.id,
        logId: res.logId,
        batchId: run.batchId,
        title:
          `新增跟进：${influencerId ? nick(d.entity('influencer').require(influencerId)) : ''}`.replace(
            /：$/,
            '',
          ),
        lines: [
          `方式：${p.method}`,
          `内容：${p.summary}`,
          p.followStatus ? `跟进状态：${p.followStatus}` : '',
          p.nextAction ? `下一步：${p.nextAction}` : '',
          next ? `下次跟进：${next.display}` : '',
        ].filter(Boolean),
      });
      return {
        ok: true,
        followUpId: res.row.id,
        nextFollowDate: next,
        note: '已写入，用户可以在卡片上撤销。',
      };
    },
  });

  add({
    name: 'create_draft_cooperation',
    label: '新建草稿合作',
    description:
      '为达人新建一个合作（阶段为"待建联"）。佣金必须带单位：commissionPct 是百分数（25 表示 25%），commissionQuote 必须逐字引用用户原话里写佣金的那一小段（如"25个点"）。坑位费同理，用 slotFeeCents（分）和 slotFeeQuote。达人已有进行中的合作时默认拒绝，用户明确要新建才传 forceNew。',
    parameters: Type.Object({
      influencerId: Type.String(),
      platformAccountId: optStr('平台账号 ID；达人只有一个账号时可省略'),
      contactId: optStr('对接的联系人 ID'),
      mode: Type.Optional(lit(['纯佣', '坑位费+佣金', '专场'])),
      slotFeeCents: Type.Optional(Type.Integer({ minimum: 0 })),
      slotFeeQuote: optStr('原话里写坑位费的那一小段'),
      products: Type.Optional(
        Type.Array(
          Type.Object({
            productId: Type.String(),
            commissionPct: Type.Optional(Type.Number()),
            commissionQuote: optStr('原话里写佣金的那一小段'),
          }),
          { maxItems: 20 },
        ),
      ),
      liveDateText: optStr('开播日期，原话里的说法'),
      nextFollowDateText: optStr('下次跟进日期，原话里的说法'),
      forceNew: Type.Optional(Type.Boolean()),
    }),
    execute: async (p) => {
      const inf = d.entity('influencer').require(p.influencerId);
      run.assertTarget('influencer', inf.id, nick(inf));
      const accounts = d.entity('platform_account').findBy('influencerId', inf.id);
      const account = p.platformAccountId
        ? accounts.find((a) => a.id === p.platformAccountId)
        : accounts.length === 1
          ? accounts[0]
          : undefined;
      if (!account)
        throw new DomainError(
          'validation',
          accounts.length
            ? '该达人有多个平台账号，请指定 platformAccountId 或让用户选择。'
            : '该达人还没有平台账号，请用户先在页面上添加。',
        );
      const open = d
        .entity('cooperation')
        .findBy('influencerId', inf.id)
        .filter((c) => !['完成', '流失', '放弃'].includes(c.stage as string));
      if (open.length && !p.forceNew) {
        run.noteMatches(open.map((c) => c.id));
        throw new DomainError(
          'validation',
          `该达人已有 ${open.length} 个进行中的合作（${open.map((c) => `${c.stage}`).join('、')}）。要在已有合作上记录，请用 find_cooperations 找到它；用户明确要新建一个合作时才传 forceNew=true。`,
        );
      }
      const warnings: string[] = [];
      if (p.slotFeeCents != null) run.money(p.slotFeeCents, p.slotFeeQuote ?? '');
      for (const it of p.products ?? []) {
        if (it.commissionPct != null) {
          run.commission(it.commissionPct, it.commissionQuote ?? '');
          warnings.push(...run.commissionWarnings(it.commissionPct, inf.id));
        }
        const pr = d.entity('product').require(it.productId);
        run.assertTarget('product', pr.id, label('product', pr));
      }
      const live = p.liveDateText ? run.date(p.liveDateText) : null;
      const next = p.nextFollowDateText ? run.date(p.nextFollowDateText) : null;
      const batchId = d.newBatchId();
      const actor = { ...run.actor(), batchId };
      const out = d.transaction(() => {
        const res = d.entity('cooperation').create(actor, {
          influencerId: inf.id,
          platformAccountId: account.id,
          contactId: p.contactId ?? null,
          mode: p.mode ?? (p.slotFeeCents ? '坑位费+佣金' : '纯佣'),
          stage: '待建联',
          slotFeeCents: p.slotFeeCents ?? null,
          liveDate: live?.date ?? null,
          nextFollowDate: next?.date ?? null,
        });
        if (res.status !== 'applied')
          throw new DomainError('invalid_state', '新建合作不应进入审核');
        for (const it of p.products ?? []) {
          d.entity('cooperation_product').create(actor, {
            cooperationId: res.row.id,
            productId: it.productId,
            commissionPct: it.commissionPct ?? null,
          });
        }
        return res;
      });
      if (out.status !== 'applied') throw new DomainError('invalid_state', '新建合作不应进入审核');
      run.lockCooperation(out.row.id, label('cooperation', out.row));
      run.emit({
        kind: 'applied',
        entity: 'cooperation',
        entityId: out.row.id,
        logId: out.logId,
        batchId,
        title: `新建草稿合作：${nick(inf)}`,
        lines: [
          `平台：${account.platform}`,
          ...(p.products ?? []).map((it: { productId: string; commissionPct?: number }) => {
            const pr = d.entity('product').peek(it.productId);
            return `商品：${pr?.styleNo} ${pr?.name}${it.commissionPct != null ? `，佣金 ${it.commissionPct}%` : ''}`;
          }),
          p.slotFeeCents != null ? `坑位费：${fmtCents(p.slotFeeCents)}` : '',
          live ? `开播：${live.display}` : '',
          next ? `下次跟进：${next.display}` : '',
        ].filter(Boolean),
        warnings: [...new Set(warnings)],
      });
      return {
        ok: true,
        cooperationId: out.row.id,
        liveDate: live,
        nextFollowDate: next,
        warnings,
      };
    },
  });

  add({
    name: 'create_sample_shipment_draft',
    label: '新建寄样草稿',
    description:
      '为达人新建一张"待寄样"的寄样单草稿（还没发货，不计入在外）。每一行用款号 + 颜色 + 尺码 + 数量。收货地址不由你填，用户寄出时在页面上填写。',
    parameters: Type.Object({
      influencerId: Type.String(),
      cooperationId: optStr('关联合作（可选）'),
      items: Type.Array(
        Type.Object({
          styleNo: Type.String(),
          color: Type.String(),
          size: Type.String(),
          qty: Type.Integer({ minimum: 1, maximum: 99 }),
        }),
        { minItems: 1, maxItems: 30 },
      ),
    }),
    execute: async (p) => {
      const inf = d.entity('influencer').require(p.influencerId);
      run.assertTarget('influencer', inf.id, nick(inf));
      if (p.cooperationId) {
        const c = d.entity('cooperation').require(p.cooperationId);
        run.assertTarget('cooperation', c.id, label('cooperation', c));
        run.lockCooperation(c.id, label('cooperation', c));
      }
      const items = p.items.map(
        (it: { styleNo: string; color: string; size: string; qty: number }) => {
          const pr = d.entity('product').findBy('styleNo', it.styleNo.trim())[0];
          if (!pr)
            throw new DomainError(
              'validation',
              `没有款号「${it.styleNo}」的商品，请用 find_products 确认款号。`,
            );
          const variants = d.entity('product_variant').findBy('productId', pr.id);
          if (
            variants.length &&
            !variants.some((v) => v.color === it.color && v.size === it.size)
          ) {
            throw new DomainError(
              'validation',
              `${pr.styleNo} ${pr.name} 没有「${it.color} ${it.size}」，可选：${variants.map((v) => `${v.color} ${v.size}`).join('、')}`,
            );
          }
          return {
            productId: pr.id,
            styleNo: pr.styleNo as string,
            productName: pr.name as string,
            color: it.color,
            size: it.size,
            qty: it.qty,
          };
        },
      );
      const batchId = d.newBatchId();
      const row = d.samples.createShipment(
        { ...run.actor(), batchId },
        { influencerId: inf.id, cooperationId: p.cooperationId ?? null, items },
      );
      run.emit({
        kind: 'applied',
        entity: 'sample_shipment',
        entityId: row.id,
        batchId,
        title: `新建寄样草稿：${nick(inf)}`,
        lines: items.map(
          (it: {
            styleNo: string;
            productName: string;
            color: string;
            size: string;
            qty: number;
          }) => `${it.styleNo} ${it.productName} ${it.color} ${it.size} ×${it.qty}`,
        ),
      });
      return {
        ok: true,
        shipmentId: row.id,
        status: '待寄样',
        note: '寄样草稿已创建，地址和快递信息由用户在寄样页面填写后标记寄出。',
      };
    },
  });

  // ═════════════ 敏感写：只生成待审核 ═════════════
  /** 校验并整理一个补丁：字段白名单、金额/佣金与原文核对、日期由程序解析 */
  const preparePatch = (
    entity: PatchEntity,
    patch: Record<string, unknown>,
    quotes: Record<string, string> = {},
    dateTexts: Record<string, string> = {},
    influencerId: string | null,
  ) => {
    const allowed = PATCHABLE[entity] as readonly string[];
    const out: Record<string, unknown> = {};
    const warnings: string[] = [];
    const notes: string[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!allowed.includes(k)) {
        throw new DomainError(
          'validation',
          k === 'stage'
            ? '改阶段请用 propose_stage_change。'
            : `字段 ${k} 不能由 AI 修改。可修改的字段：${allowed.join('、')}。手机号、微信号、地址、真实姓名请用户在页面上手动填写。`,
        );
      }
      if (DATE_FIELDS.has(k))
        throw new DomainError(
          'validation',
          `日期字段 ${k} 不能直接给值：请把原话里的日期说法放进 dateTexts.${k}，由程序解析。`,
        );
      run.assertNoPlaceholders(v);
      if (isMoneyField(k)) {
        if (typeof v !== 'number')
          throw new DomainError('validation', `${k} 必须是以"分"为单位的整数。`);
        run.money(v, quotes[k] ?? '');
      } else if (PCT_FIELDS.has(k)) {
        if (typeof v !== 'number')
          throw new DomainError('validation', `${k} 必须是百分数的数字（25 表示 25%）。`);
        run.commission(v, quotes[k] ?? '');
        warnings.push(...run.commissionWarnings(v, influencerId));
      }
      out[k] = v;
    }
    for (const [k, phrase] of Object.entries(dateTexts)) {
      if (!allowed.includes(k) || !DATE_FIELDS.has(k))
        throw new DomainError('validation', `${k} 不是可以用日期说法设置的字段。`);
      const r = run.date(phrase);
      out[k] = r.date;
      notes.push(`${k}：${r.display}`);
    }
    if (!Object.keys(out).length) throw new DomainError('validation', '没有要修改的字段');
    return { patch: out, warnings: [...new Set(warnings)], notes };
  };

  /** 确认目标并取出相关的达人，合作类还要锁定"一次只写一个合作" */
  const claimTarget = (entity: PatchEntity, id: string) => {
    const svc = d.entity(entity);
    const row = svc.require(id);
    let influencerId: string | null = null;
    if (entity === 'influencer') {
      run.assertTarget('influencer', id, label('influencer', row));
      influencerId = id;
    } else if (entity === 'cooperation') {
      run.assertTarget('cooperation', id, label('cooperation', row));
      run.lockCooperation(id, label('cooperation', row));
      influencerId = row.influencerId as string;
    } else if (entity === 'cooperation_product') {
      const c = d.entity('cooperation').require(row.cooperationId as string);
      run.assertTarget('cooperation', c.id, label('cooperation', c));
      run.lockCooperation(c.id, label('cooperation', c));
      influencerId = c.influencerId as string;
    } else {
      run.assertTarget(entity, id, label(entity, row));
    }
    return { svc, row, influencerId };
  };

  const pendingCard = (
    entity: string,
    row: Row,
    pendingId: string,
    reason: string,
    warnings: string[],
    title: string,
  ) =>
    run.emit({
      kind: 'pending',
      entity,
      entityId: row.id,
      pendingId,
      batchId: run.batchId,
      title,
      lines: [reason],
      warnings,
    });

  const patchSchema = {
    patch: Type.Record(Type.String(), Type.Any(), {
      description: '要改的字段 → 新值。金额字段单位是"分"，佣金是百分数。不含日期字段',
    }),
    quotes: Type.Optional(
      Type.Record(Type.String(), Type.String(), {
        description:
          '金额/佣金字段 → 原话里写这个数字的那一小段（逐字引用，必须带单位，如"25个点""1.2万"）',
      }),
    ),
    dateTexts: Type.Optional(
      Type.Record(Type.String(), Type.String(), {
        description: '日期字段（liveDate、nextFollowDate）→ 原话里的日期说法',
      }),
    ),
  };

  add({
    name: 'propose_update',
    label: '提出修改',
    description:
      '提出修改达人、合作、合作商品（佣金等）、商品或联系人的字段。只会生成待审核卡片，用户确认后才生效。金额和佣金必须在 quotes 里逐字引用原话，数值对不上会被拒绝；日期通过 dateTexts 交给程序解析。合作商品的佣金改动传 entity=cooperation_product、id=合作商品 ID（见 get_cooperation 的 products[].id）。',
    parameters: Type.Object({ entity: lit(PATCH_ENTITIES), id: Type.String(), ...patchSchema }),
    execute: async (p) => {
      const entity = p.entity as PatchEntity;
      const { svc, row, influencerId } = claimTarget(entity, p.id);
      const prepared = preparePatch(entity, p.patch, p.quotes, p.dateTexts, influencerId);
      const res = svc.propose(run.actor(), row.id, prepared.patch, { warnings: prepared.warnings });
      if (res.status !== 'pending') throw new DomainError('invalid_state', 'AI 的修改必须进入审核');
      pendingCard(
        entity,
        row,
        res.pendingId,
        res.reason,
        prepared.warnings,
        `修改「${guard.sanitize(d.reviewView.displayName(entity, row))}」`,
      );
      return {
        ok: true,
        status: 'pending',
        reason: res.reason,
        resolvedDates: prepared.notes,
        warnings: prepared.warnings,
        note: '已生成待审核卡片，用户确认后才生效。',
      };
    },
  });

  add({
    name: 'propose_stage_change',
    label: '提出改阶段',
    description: `提出改变合作阶段（${COOP_STAGES.join(' → ')}）。只生成待审核卡片。进入"洽谈中"需要下次跟进日期（nextFollowDateText）；进入流失/放弃需要 lostReason。`,
    parameters: Type.Object({
      cooperationId: Type.String(),
      stage: lit(COOP_STAGES),
      followStatus: optStr('洽谈中的跟进状态'),
      lostReason: optStr('流失/放弃原因'),
      nextFollowDateText: optStr('下次跟进日期，原话里的说法'),
    }),
    execute: async (p) => {
      const { svc, row, influencerId } = claimTarget('cooperation', p.cooperationId);
      void influencerId;
      const patch: Record<string, unknown> = { stage: p.stage };
      if (p.followStatus) patch.followStatus = p.followStatus;
      if (p.lostReason) patch.lostReason = p.lostReason;
      run.assertNoPlaceholders(patch);
      let note: string | undefined;
      if (p.nextFollowDateText) {
        const r = run.date(p.nextFollowDateText);
        patch.nextFollowDate = r.date;
        note = `下次跟进：${r.display}`;
      }
      const res = svc.propose(run.actor(), row.id, patch, {
        reason: `改阶段：${row.stage} → ${p.stage}`,
      });
      if (res.status !== 'pending') throw new DomainError('invalid_state', 'AI 的修改必须进入审核');
      pendingCard(
        'cooperation',
        row,
        res.pendingId,
        res.reason,
        [],
        `合作阶段：${row.stage} → ${p.stage}`,
      );
      return { ok: true, status: 'pending', note: note ?? '已生成待审核卡片，用户确认后才生效。' };
    },
  });

  add({
    name: 'propose_merge_influencers',
    label: '提出合并达人',
    description:
      '提出把重复的达人 mergeId 合并到 keepId。只生成待审核卡片；两个达人都必须经过用户确认，不能因为名字相似就自行判断是同一人。',
    parameters: Type.Object({ keepId: Type.String(), mergeId: Type.String() }),
    execute: async (p) => {
      const keep = d.entity('influencer').require(p.keepId);
      const merge = d.entity('influencer').require(p.mergeId);
      run.assertTarget('influencer', keep.id, nick(keep));
      run.assertTarget('influencer', merge.id, nick(merge));
      const res = d.influencers.requestMerge(run.actor(), keep.id, merge.id);
      if (res.status !== 'pending') throw new DomainError('invalid_state', '合并必须进入审核');
      pendingCard(
        'influencer',
        keep,
        res.pendingId,
        res.reason,
        [],
        `合并达人：${nick(merge)} → ${nick(keep)}`,
      );
      return { ok: true, status: 'pending', note: '已生成待审核卡片，用户确认后才合并。' };
    },
  });

  add({
    name: 'propose_delete',
    label: '提出删除',
    description:
      '提出删除一条记录（达人、联系人、商品、合作）。只生成待审核卡片，用户确认后才会删除（可撤销）。',
    parameters: Type.Object({
      entity: lit(['influencer', 'contact', 'product', 'cooperation']),
      id: Type.String(),
    }),
    execute: async (p) => {
      const entity = p.entity as PatchEntity;
      const { svc, row } = claimTarget(entity, p.id);
      const res = svc.proposeDelete(run.actor(), row.id);
      if (res.status !== 'pending') throw new DomainError('invalid_state', '删除必须进入审核');
      pendingCard(
        entity,
        row,
        res.pendingId,
        res.reason,
        [],
        `删除「${guard.sanitize(d.reviewView.displayName(entity, row))}」`,
      );
      return { ok: true, status: 'pending', note: '已生成待审核卡片，用户确认后才会删除。' };
    },
  });

  add({
    name: 'propose_bulk_update',
    label: '提出批量修改',
    description: `对多条记录套用同一个修改（最多 ${MAX_BATCH} 条）。ids 必须是本轮查询工具返回过的记录。整批只生成待审核记录，在审核页可以整批通过或驳回。`,
    parameters: Type.Object({
      entity: lit(['influencer', 'cooperation', 'product', 'contact']),
      ids: Type.Array(Type.String(), { minItems: 1, maxItems: MAX_BATCH }),
      ...patchSchema,
    }),
    execute: async (p) => {
      const entity = p.entity as PatchEntity;
      if (p.ids.length > MAX_BATCH)
        throw new DomainError('validation', `单次批量改动不能超过 ${MAX_BATCH} 条`);
      const svc = d.entity(entity);
      const ids = [...new Set(p.ids as string[])];
      const rows = ids.map((id) => {
        const row = svc.require(id);
        if (!run.isConfirmed(id) && !run.knows(id))
          throw new DomainError(
            'validation',
            `记录 ${id} 不是本轮查询到的，批量修改的目标必须来自查询结果。`,
          );
        return row;
      });
      const infId = (r: Row) =>
        entity === 'influencer'
          ? r.id
          : entity === 'cooperation'
            ? (r.influencerId as string)
            : null;
      const warnings = new Set<string>();
      const prepared = rows.map((r) => {
        const x = preparePatch(entity, p.patch, p.quotes, p.dateTexts, infId(r));
        x.warnings.forEach((w) => warnings.add(w));
        return { row: r, ...x };
      });
      const actor = run.actor();
      const done = d.transaction(() =>
        prepared.map((x) =>
          svc.propose(actor, x.row.id, x.patch, { reason: '批量修改', warnings: x.warnings }),
        ),
      );
      run.emit({
        kind: 'batch',
        entity,
        batchId: run.batchId,
        count: done.length,
        title: `批量修改 ${done.length} 条${({ influencer: '达人', cooperation: '合作', product: '商品', contact: '联系人', cooperation_product: '合作商品' } as const)[entity]}`,
        lines: Object.entries(prepared[0]!.patch).map(([k, v]) => `${k} → ${String(v)}`),
        warnings: [...warnings],
      });
      return {
        ok: true,
        status: 'pending',
        count: done.length,
        note: '已生成整批待审核记录，用户在审核页确认后才生效。',
      };
    },
  });

  return tools;
}

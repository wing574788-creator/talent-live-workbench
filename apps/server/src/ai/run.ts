/**
 * 一次 AI 运行（用户发一条消息 → 模型调用若干工具 → 回复）的状态和护栏（PRD 7.3）。
 * 工具把"能不能写"的判断都交给这里：目标确认、一次只写一个合作、日期/金额/佣金和原文核对。
 */
import { DomainError } from '../domain/errors.ts';
import type { Domain } from '../domain/index.ts';
import type { Actor } from '../domain/types.ts';
import { resolveDate, ShDate, type ResolvedDate } from './dates.ts';
import { OutboundGuard } from './outbound.ts';
import { commissionWarnings, normText, verifyCommission, verifyMoneyCents } from './verify.ts';

/** 侧栏里展示的卡片 */
export interface Card {
  id: string;
  kind: 'pending' | 'applied' | 'choose' | 'batch';
  title: string;
  entity?: string;
  entityId?: string;
  /** 待审核改动的 id（卡片上可改字段、通过、驳回） */
  pendingId?: string;
  /** 已落库改动的日志 id（可撤销） */
  logId?: string;
  batchId?: string;
  /** 已落库的内容概述，每行一句 */
  lines?: string[];
  warnings?: string[];
  /** 需要用户选择时的候选 */
  question?: string;
  candidates?: { id: string; type: string; label: string; detail?: string }[];
  count?: number;
}

export interface RunContext {
  page?: string;
  selected?: { type: string; id: string };
}

export interface RunOptions {
  /** 用户本轮的原话（或截图识别出的文字）：金额、佣金、日期都要和它核对 */
  originalText: string;
  /** 用户明确选定的目标（从候选卡片里点选，或侧栏带着当前选中的记录） */
  confirmed?: string[];
  context?: RunContext;
  now?: Date;
  emit?: (card: Card) => void;
  /** 出处标注，如"AI 录入"、"截图录入" */
  sourceLabel?: string;
  /** 截图录入时，原图的附件 id（写进跟进记录的出处） */
  sourceAttachmentId?: string;
}

const PLACEHOLDER = /\[(?:手机号|微信号|地址|姓名|证件号|邮箱)\d+\]/;

export class AiRun {
  readonly batchId: string;
  readonly cards: Card[] = [];
  readonly originalText: string;
  readonly now: Date;
  readonly context: RunContext;
  private readonly confirmed = new Set<string>();
  /** 查询工具返回过的记录 → 同一次查询匹配到几条（1 = 唯一） */
  private readonly groups = new Map<string, number>();
  private lockedCooperation: string | null = null;
  awaitingChoice = false;
  private cardSeq = 0;

  constructor(
    readonly d: Domain,
    readonly guard: OutboundGuard,
    private readonly opts: RunOptions,
  ) {
    this.batchId = d.newBatchId();
    this.originalText = opts.originalText;
    this.now = opts.now ?? new Date();
    this.context = opts.context ?? {};
    for (const id of opts.confirmed ?? []) this.confirmed.add(id);
    if (this.context.selected) this.confirmed.add(this.context.selected.id);
  }

  get sourceAttachmentId() {
    return this.opts.sourceAttachmentId ?? null;
  }

  today() {
    return ShDate.today(this.now).iso();
  }

  /** AI 的写入身份：批次号统一，出处记原话（截短），方便在审核页和详情页查看 */
  actor(): Actor {
    const label = this.opts.sourceLabel ?? 'AI 录入';
    const text = this.originalText.replace(/\s+/g, ' ').trim();
    return {
      type: 'agent',
      userId: this.d.userId,
      batchId: this.batchId,
      source: `${label}：${text.length > 300 ? text.slice(0, 300) + '…' : text}`,
    };
  }

  emit(card: Omit<Card, 'id'>): Card {
    const full = { ...card, id: `${this.batchId}-${++this.cardSeq}` } as Card;
    this.cards.push(full);
    this.opts.emit?.(full);
    return full;
  }

  // ───────────── 目标确认 ─────────────
  /** 查询工具返回候选后登记：只有一条的算"唯一匹配"，多于一条的必须让用户选 */
  noteMatches(ids: string[], groupSize = ids.length) {
    for (const id of ids) {
      const prev = this.groups.get(id);
      this.groups.set(id, prev === undefined ? groupSize : Math.min(prev, groupSize));
    }
  }

  /** 本轮查询工具返回过这条记录 */
  knows(id: string) {
    return this.groups.has(id);
  }

  /** 用户在候选卡片里选定（或侧栏当前选中）的记录 */
  confirm(ids: string[]) {
    for (const id of ids) this.confirmed.add(id);
  }

  isConfirmed(id: string) {
    return this.confirmed.has(id);
  }

  /** 写入前确认目标：用户选定的，或查询时唯一匹配的；候选有多个而没人选，不允许自动选 */
  assertTarget(type: string, id: string, label: string) {
    if (this.awaitingChoice) {
      throw new DomainError(
        'validation',
        '已经请用户选择目标了，本轮不要再写入，等用户回复后再继续。',
      );
    }
    if (this.confirmed.has(id)) return;
    // 用户确认了某个合作，就等于确认了这个合作的达人
    if (type === 'influencer') {
      for (const cid of this.confirmed) {
        if (this.d.entity('cooperation').peek(cid)?.influencerId === id) return;
      }
    }
    const size = this.groups.get(id);
    if (size === 1) return;
    if (size === undefined) {
      throw new DomainError(
        'validation',
        `「${label}」不是本轮查询到的记录，也没有经过用户确认。请先用查询工具找到它；如果有多个候选，用 ask_user_to_choose 让用户选。`,
      );
    }
    throw new DomainError(
      'validation',
      `「${label}」是 ${size} 个同名候选之一，不能自动选择。请调用 ask_user_to_choose 把候选展示给用户，由用户选定后再写入。`,
    );
  }

  /** 一次提取只写一个合作 */
  lockCooperation(id: string, label: string) {
    if (this.lockedCooperation && this.lockedCooperation !== id) {
      throw new DomainError(
        'validation',
        `一次录入只能写一个合作，本轮已经在处理「${this.labelOfCooperation(this.lockedCooperation)}」。「${label}」请让用户另外发一条消息处理。`,
      );
    }
    this.lockedCooperation = id;
  }

  private labelOfCooperation(id: string) {
    const c = this.d.entity('cooperation').peek(id);
    return c ? this.d.reviewView.displayName('cooperation', c) : id;
  }

  // ───────────── 原文核对 ─────────────
  /** 日期：说法必须来自用户原话，由程序解析成绝对日期；模型自己算的日期不接受 */
  date(phrase: string, prefer: 'future' | 'nearest' | 'past' = 'future'): ResolvedDate {
    const p = phrase.trim();
    if (!p)
      throw new DomainError(
        'validation',
        '缺少日期说法：请把用户原话里的日期说法（如"下周三"）原样填入。',
      );
    if (!normText(this.originalText).includes(normText(p).replace(/[,，。]/g, ''))) {
      throw new DomainError(
        'validation',
        `日期说法「${p}」不在用户的原话里。日期必须来自原文，由程序解析；不要自己推算。`,
      );
    }
    const r = resolveDate(p, this.now, prefer);
    if (!r)
      throw new DomainError(
        'validation',
        `无法解析日期「${p}」。请向用户确认具体日期（如"10月21日"）。`,
      );
    return r;
  }

  commission(value: number, quote: string): string[] {
    verifyCommission(value, quote, this.originalText);
    return [];
  }

  money(cents: number, quote: string) {
    verifyMoneyCents(cents, quote, this.originalText);
  }

  /** 佣金异常警告：超过 50%，或偏离该达人历史值 */
  commissionWarnings(pct: number, influencerId: string | null): string[] {
    const history: number[] = [];
    if (influencerId) {
      const inf = this.d.entity('influencer').peek(influencerId);
      if (typeof inf?.refCommissionPct === 'number') history.push(inf.refCommissionPct);
      const coopIds = new Set(
        this.d
          .entity('cooperation')
          .findBy('influencerId', influencerId)
          .map((c) => c.id),
      );
      for (const cp of this.d.entity('cooperation_product').list()) {
        if (coopIds.has(cp.cooperationId as string) && typeof cp.commissionPct === 'number')
          history.push(cp.commissionPct);
      }
    }
    return commissionWarnings(pct, history);
  }

  /** 补丁里不能带本地脱敏的占位符（模型看到的是 [手机号1]，不是真实值） */
  assertNoPlaceholders(value: unknown) {
    const bad = (v: unknown): boolean =>
      typeof v === 'string'
        ? PLACEHOLDER.test(v)
        : Array.isArray(v)
          ? v.some(bad)
          : v && typeof v === 'object'
            ? Object.values(v).some(bad)
            : false;
    if (bad(value)) {
      throw new DomainError(
        'validation',
        '内容里含有被本地脱敏的占位符（如 [手机号1]），那不是真实值。手机号、微信号、地址、真实姓名请用户在页面上手动填写。',
      );
    }
  }
}

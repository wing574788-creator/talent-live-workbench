/**
 * 首页 AI 摘要（PRD 7.1 第 4 条）：把首页数据整理成一份精简的快照发给模型，让它写 3~5 条要点。
 * 同一天缓存一次，可以重新生成；没配置模型、模型失败时首页仍显示按规则生成的概况。
 */
import { and, eq } from 'drizzle-orm';
import { summaryCache } from '../db/schema.ts';
import { DomainError } from '../domain/errors.ts';
import type { AiContext } from './index.ts';
import { OutboundGuard } from './outbound.ts';

const SYSTEM = [
  '你是「达人直播工作台」首页的摘要助手。根据给你的 JSON 数据，写今天最值得关注的 3~5 条要点。',
  '要求：',
  '- 每条一句话，以"- "开头，中文，直接说事，不要客套。',
  '- 只使用数据里有的信息，不要编造；没有需要关注的事就写一条"今天没有特别需要留意的事"。',
  '- 提到达人时用链接格式 [昵称](链接)，链接取自数据里的 link 字段原样复制。',
  '- 日期写成数据里给出的写法，不要自己推算。',
  '- 优先级：已逾期的跟进 > 逾期未寄回的样衣 > 近期开播但佣金/挂链未确认 > 待审核的改动。',
].join('\n');

interface Cached {
  content: string;
  generatedAt: string;
}

export class HomeSummary {
  private inflight = new Map<string, Promise<Cached>>();

  constructor(private readonly ai: AiContext) {}

  private get db() {
    return this.ai.domain.db;
  }

  cached(day: string): Cached | null {
    const row = this.db
      .select()
      .from(summaryCache)
      .where(and(eq(summaryCache.day, day), eq(summaryCache.kind, 'home')))
      .get();
    return row ? { content: row.content, generatedAt: row.updatedAt } : null;
  }

  /** 当天有缓存就直接用；refresh = true 重新生成 */
  async get(day: string, refresh = false): Promise<Cached & { cached: boolean }> {
    if (!refresh) {
      const hit = this.cached(day);
      if (hit) return { ...hit, cached: true };
    }
    let p = this.inflight.get(day);
    if (!p) {
      p = this.generate(day).finally(() => this.inflight.delete(day));
      this.inflight.set(day, p);
    }
    return { ...(await p), cached: false };
  }

  /** 给模型的快照：只有昵称、阶段、天数、数量这类，按外发配置裁剪 */
  snapshot(day: string) {
    const d = this.ai.domain;
    const guard = new OutboundGuard(d);
    const dash = d.home.dashboard(day);
    const hide = ['deny', 'mask'].includes(guard.policy.fields['influencer.nickname'] ?? 'allow');
    const nick = (n: string) => (hide ? '[已隐藏]' : guard.sanitize(n));
    const out: Record<string, unknown> = { today: day, counts: dash.cards };
    if (guard.moduleAllowed('cooperation')) {
      out.dueFollows = dash.dueFollows.slice(0, 8).map((x) => ({
        name:
          x.kind === 'cooperation'
            ? nick(x.name)
            : guard.moduleAllowed('contact')
              ? guard.sanitize(x.name)
              : '[已隐藏]',
        stage: x.stage,
        overdueDays: x.overdueDays,
        nextAction: x.nextAction ? guard.sanitize(x.nextAction) : null,
        link: `wb:${x.kind}:${x.id}`,
      }));
      out.upcomingLives = dash.upcomingLives.map((x) => ({
        name: nick(x.influencerNickname),
        liveDate: x.liveDate,
        commissionUnconfirmed: x.commissionUnconfirmed,
        linkMissing: x.linkMissing,
        link: `wb:cooperation:${x.cooperationId}`,
      }));
    }
    if (guard.moduleAllowed('shipment')) {
      out.sampleAlerts = dash.sampleAlerts.slice(0, 8).map((a) => ({
        name: nick(a.nickname),
        outstanding: a.outstanding,
        alerts: a.alerts.map((x) => x.text),
        link: `wb:influencer:${a.influencerId}`,
      }));
    }
    return out;
  }

  private async generate(day: string): Promise<Cached> {
    const content = await this.ai.service.complete(
      'summary',
      SYSTEM,
      JSON.stringify(this.snapshot(day)),
    );
    if (!content) throw new DomainError('validation', '模型没有返回内容，请稍后重试');
    const now = new Date().toISOString();
    this.db
      .insert(summaryCache)
      .values({
        id: this.ai.domain.newBatchId(),
        day,
        kind: 'home',
        content,
        createdBy: this.ai.domain.userId,
        ownerId: this.ai.domain.userId,
      })
      .onConflictDoUpdate({
        target: [summaryCache.day, summaryCache.kind],
        set: { content, updatedAt: now },
      })
      .run();
    return { content, generatedAt: now };
  }
}

import { COOP_MAIN_STAGES } from '@workbench/shared';
import type { ServiceRegistry } from './entity-service.ts';
import { outstandingTotal } from './sample-ledger.ts';
import type { Actor, Row } from './types.ts';
import { changeLog } from '../db/schema.ts';
import type { Db } from '../db/index.ts';
import { and, eq } from 'drizzle-orm';

type Stage = (typeof COOP_MAIN_STAGES)[number];
const before = (...stages: Stage[]) => stages;

export const AUTO_SOURCE = '自动推进';

/** 北京时间的今天（YYYY-MM-DD）。时区固定 Asia/Shanghai。 */
export function todayShanghai(now = new Date()): string {
  return new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

/**
 * 把"日期或带时间的 ISO 时间（UTC）"换成北京时间的日期。纯日期原样返回。
 * 不能直接 slice(0, 10)：北京时间 00:00–08:00 的 UTC 日期还是前一天。
 */
export function dateShanghai(value: string): string {
  return value.length <= 10 ? value : todayShanghai(new Date(value));
}

/**
 * 合作阶段自动推进（PRD 5.3 验收）：
 *   新建待寄样单 → 待寄样；寄出 → 已排期；开播日过后 → 已开播；
 *   开播后仍有在外样品 → 待退样；样品结清 → 待复盘。
 * 都只"向前推进"，改动记变更日志（来源标"自动推进"），用户可以手动改回；
 * 基于时间/状态的规则每条合作只自动触发一次，所以手动改回后不会被反复推走。
 */
export class CooperationAutomation {
  constructor(
    private readonly db: Db,
    private readonly registry: ServiceRegistry,
    private readonly actor: () => Actor,
  ) {}

  private coop() {
    return this.registry.get('cooperation');
  }

  private move(
    c: Row,
    target: Stage,
    allowedFrom: Stage[],
    why: string,
    oneShot: boolean,
  ): boolean {
    if (!allowedFrom.includes(c.stage as Stage)) return false;
    if (oneShot && this.alreadyAuto(c.id, target)) return false;
    const actor = { ...this.actor(), source: `${AUTO_SOURCE}：${why}` };
    this.coop().update(actor, c.id, { stage: target });
    return true;
  }

  private alreadyAuto(coopId: string, target: string): boolean {
    return this.db
      .select()
      .from(changeLog)
      .where(and(eq(changeLog.entity, 'cooperation'), eq(changeLog.entityId, coopId)))
      .all()
      .some((l) => l.source?.startsWith(AUTO_SOURCE) && (l.after as Row | null)?.stage === target);
  }

  /** 新建待寄样单（关联合作）→ 待寄样 */
  onShipmentCreated(cooperationId: string | null | undefined) {
    const c = cooperationId ? this.coop().get(cooperationId) : undefined;
    if (c) this.move(c, '待寄样', before('待建联', '洽谈中', '已确认'), '新建待寄样单', false);
  }

  /** 寄样单寄出 → 已排期 */
  onShipped(cooperationId: string | null | undefined) {
    const c = cooperationId ? this.coop().get(cooperationId) : undefined;
    if (c)
      this.move(c, '已排期', before('待建联', '洽谈中', '已确认', '待寄样'), '样衣已寄出', false);
  }

  /** 寄出/退回/核销之后，按在外数量推进或回到待复盘 */
  onSamplesChanged(influencerId: string) {
    for (const c of this.coop().findBy('influencerId', influencerId)) this.applySampleRules(c);
  }

  private applySampleRules(c: Row) {
    const out = outstandingTotal(this.registry, c.influencerId as string);
    if (c.stage === '已开播' && out > 0)
      this.move(c, '待退样', ['已开播'], '开播后仍有在外样品', true);
    else if (c.stage === '待退样' && out === 0) {
      this.move(c, '待复盘', ['待退样'], '样品已结清', true);
    }
  }

  /** 每天跑一次（也可手动触发）：开播日过后 → 已开播，再按样品情况继续推进 */
  runDaily(today = todayShanghai()): { advanced: number } {
    let advanced = 0;
    for (const c of this.coop().list()) {
      const liveDate = c.liveDate as string | null;
      let cur = c;
      if (cur.stage === '已排期' && liveDate && liveDate < today) {
        if (this.move(cur, '已开播', ['已排期'], '开播日已过', true)) {
          advanced++;
          cur = this.coop().require(c.id);
        }
      }
      const stageBefore = cur.stage;
      this.applySampleRules(cur);
      if (this.coop().require(c.id).stage !== stageBefore) advanced++;
    }
    return { advanced };
  }
}

import type { ActorType } from '@workbench/shared';

/** 操作者：用户 / AI / 导入。userId 是代表其行动的用户（单人模式即默认用户）。 */
export interface Actor {
  type: ActorType;
  userId: string;
  batchId?: string;
  /** 出处：AI 录入的原文摘要、导入文件名等 */
  source?: string;
}

export type Row = Record<string, unknown> & { id: string; version: number };

export type WriteResult =
  | { status: 'applied'; row: Row; logId: string }
  | { status: 'pending'; pendingId: string; reason: string };

/** 判断一次改动是否敏感，返回原因；非敏感返回 undefined。 */
export type SensitivityRule = (ctx: {
  action: 'update' | 'delete';
  before: Row;
  patch?: Record<string, unknown>;
}) => string | undefined;

/** 批量改动上限（PRD 7.3） */
export const MAX_BATCH = 200;

/** 取出已落库的结果；若进了审核队列则抛错（脚本和测试用）。 */
export function appliedOf(r: WriteResult): { row: Row; logId: string } {
  if (r.status !== 'applied') throw new Error(`改动进入了审核队列：${r.reason}`);
  return r;
}

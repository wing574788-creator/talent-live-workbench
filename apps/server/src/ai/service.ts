/**
 * AI 会话服务：一条用户消息 = 一次运行。
 *   解析模型 → 外发配置检查 → 建运行状态和工具 → 建 Pi 会话（接着上次的 JSONL）→ 流式输出 → 保存回显记录。
 * Pi 的内置工具全部关闭，只给领域工具；每次请求都经过外发网关。
 */
import fs from 'node:fs';
import path from 'node:path';
import { desc, eq, isNull } from 'drizzle-orm';
import { createWorkbenchSession } from '../agent/adapter.ts';
import type { Purpose } from './config.ts';
import { aiSessions } from '../db/schema.ts';
import { newId } from '../domain/entity-service.ts';
import { DomainError } from '../domain/errors.ts';
import type { AiContext } from './index.ts';
import { assertTargetAllowed, createOutboundFilter } from './gateway.ts';
import { OutboundGuard } from './outbound.ts';
import { READ_ONLY_TOOLS, buildSystemPrompt, type ChatMode } from './prompt.ts';
import { AiRun, type Card, type RunContext } from './run.ts';
import { buildTools } from './tools.ts';
import { assertFeature, loadPermissions, toolAllowed } from './permissions.ts';
import { AI_PROPOSE_TOOLS, AI_WRITE_TOOLS } from '@workbench/shared';

/** 推给侧栏的事件 */
export type ChatEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'text'; delta: string }
  | {
      type: 'tool';
      name: string;
      label: string;
      state: 'start' | 'end' | 'error';
      message?: string;
      args?: unknown;
    }
  | { type: 'card'; card: Card }
  | { type: 'done' }
  | { type: 'error'; message: string; code?: string };

export interface TranscriptMessage {
  role: 'user' | 'assistant';
  text: string;
  cards?: Card[];
  mode?: ChatMode;
  at: string;
  /** 截图识别等来源提示 */
  note?: string;
}

export interface ChatRequest {
  sessionId?: string;
  text: string;
  mode: ChatMode;
  /** 用户在候选卡片里点选的记录 */
  confirmed?: string[];
  context?: RunContext;
  sourceLabel?: string;
  /** 给侧栏回显的附注（如"来自截图识别"） */
  note?: string;
  /** 接着上一条继续（如用户点选了候选）：上一条消息的原文，金额/日期仍要和它核对 */
  carryText?: string;
  /** 截图录入：原图附件 id */
  sourceAttachmentId?: string;
  now?: Date;
}

const TOOL_LABEL: Record<string, string> = {
  get_current_time: '查看当前时间',
  resolve_date: '解析日期',
  find_influencers: '搜索达人',
  find_cooperations: '搜索合作',
  find_products: '搜索商品',
  find_contacts: '搜索联系人',
  get_influencer: '查看达人',
  get_cooperation: '查看合作',
  get_product: '查看商品',
  get_sample_balance: '查看样衣台账',
  run_stats: '统计查询',
  ask_user_to_choose: '请你选择',
  add_follow_up: '记录跟进',
  create_draft_cooperation: '新建草稿合作',
  create_sample_shipment_draft: '新建寄样草稿',
  propose_update: '提出修改',
  propose_stage_change: '提出改阶段',
  propose_merge_influencers: '提出合并',
  propose_delete: '提出删除',
  propose_bulk_update: '提出批量修改',
};

export class AiService {
  private readonly active = new Map<string, () => Promise<void>>();

  constructor(private readonly ai: AiContext) {}

  private get db() {
    return this.ai.domain.db;
  }
  private get dataDir() {
    return this.ai.store.dataDir;
  }

  // ───────────── 会话索引 ─────────────
  listSessions() {
    return this.db
      .select({ id: aiSessions.id, title: aiSessions.title, updatedAt: aiSessions.updatedAt })
      .from(aiSessions)
      .where(isNull(aiSessions.deletedAt))
      .orderBy(desc(aiSessions.updatedAt))
      .limit(30)
      .all();
  }

  getSession(id: string) {
    const row = this.db.select().from(aiSessions).where(eq(aiSessions.id, id)).get();
    if (!row || row.deletedAt) throw new DomainError('not_found', '会话不存在');
    return row;
  }

  deleteSession(id: string) {
    const row = this.getSession(id);
    if (row.file) fs.rmSync(path.join(this.dataDir, row.file), { force: true });
    this.db
      .update(aiSessions)
      .set({ deletedAt: new Date().toISOString() })
      .where(eq(aiSessions.id, id))
      .run();
  }

  /** 正在运行的请求（客户端点"停止"时中止） */
  async stop(sessionId: string) {
    await this.active.get(sessionId)?.();
  }

  // ───────────── 单次补全（首页摘要、映射建议）：没有工具，一问一答 ─────────────
  /** 同样经过外发配置检查、固定脱敏和外发日志 */
  async complete(
    purpose: Purpose,
    system: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const d = this.ai.domain;
    const resolved = await this.ai.resolver.resolve(purpose);
    assertTargetAllowed(d, { provider: resolved.provider, modelId: resolved.modelId, purpose });
    let blocked: Error | undefined;
    const session = await createWorkbenchSession({
      cwd: this.dataDir,
      agentDir: resolved.agentDir,
      model: resolved.model,
      modelRuntime: resolved.modelRuntime,
      tools: [],
      systemPrompt: system,
      outboundFilter: createOutboundFilter(d, {
        provider: resolved.provider,
        modelId: resolved.modelId,
        purpose,
      }),
      onBlocked: (e) => (blocked = e),
    });
    let reply = '';
    let failure: string | undefined;
    const onAbort = () => void session.abort();
    signal?.addEventListener('abort', onAbort);
    try {
      await session.prompt(text, (e) => {
        if (e.type === 'text') reply += e.delta;
        else if (e.type === 'error') failure = e.message;
      });
    } finally {
      signal?.removeEventListener('abort', onAbort);
      session.dispose();
    }
    if (blocked)
      throw new DomainError('outbound_blocked', `外发被拦截：${(blocked as Error).message}`);
    if (failure) throw new DomainError('validation', friendlyError(failure));
    return reply.trim();
  }

  // ───────────── 一次对话 ─────────────
  async chat(req: ChatRequest, emit: (e: ChatEvent) => void, signal?: AbortSignal): Promise<void> {
    const d = this.ai.domain;
    const text = req.text.trim();
    try {
      if (!text) throw new DomainError('validation', '请先输入内容');
      if (req.mode === 'chat') assertFeature(d, 'chat');
      const purpose = req.mode === 'chat' ? 'chat' : 'extract';
      const resolved = await this.ai.resolver.resolve(purpose);
      assertTargetAllowed(d, { provider: resolved.provider, modelId: resolved.modelId, purpose });

      // 会话
      let row = req.sessionId ? this.getSession(req.sessionId) : undefined;
      if (!row) {
        const id = newId();
        this.db
          .insert(aiSessions)
          .values({
            id,
            title: text.slice(0, 24),
            createdBy: d.userId,
            ownerId: d.userId,
            transcript: [],
          })
          .run();
        row = this.getSession(id);
      }
      const sessionId = row.id;
      emit({ type: 'session', sessionId });
      const transcript = [...((row.transcript ?? []) as TranscriptMessage[])];
      transcript.push({
        role: 'user',
        text,
        mode: req.mode,
        at: new Date().toISOString(),
        note: req.note,
      });
      this.saveTranscript(sessionId, transcript);

      // 运行状态与工具
      const guard = new OutboundGuard(d);
      const confirmed = [...(req.confirmed ?? [])];
      const run = new AiRun(d, guard, {
        originalText: req.carryText ? [req.carryText, text].join('\n') : text,
        confirmed,
        context: req.context,
        now: req.now,
        sourceLabel:
          req.sourceLabel ??
          (req.sourceAttachmentId ? '截图录入' : req.mode === 'chat' ? 'AI 问答' : 'AI 录入'),
        sourceAttachmentId: req.sourceAttachmentId,
        emit: (card) => emit({ type: 'card', card }),
      });
      const perms = loadPermissions(d);
      const tools = buildTools(run).filter(
        (t) =>
          (req.mode === 'extract' || READ_ONLY_TOOLS.has(t.name)) && toolAllowed(perms, t.name),
      );
      const disabled =
        req.mode === 'extract'
          ? Object.entries({ ...AI_WRITE_TOOLS, ...AI_PROPOSE_TOOLS })
              .filter(([k]) => !toolAllowed(perms, k))
              .map(([, v]) => v)
          : [];
      const sel = req.context?.selected;
      const selectedLabel = sel ? this.selectedLabel(sel.type, sel.id, guard) : undefined;

      let blocked: Error | undefined;
      const session = await createWorkbenchSession({
        cwd: this.dataDir,
        agentDir: resolved.agentDir,
        model: resolved.model,
        modelRuntime: resolved.modelRuntime,
        tools,
        systemPrompt: buildSystemPrompt({
          mode: req.mode,
          now: req.now,
          context: req.context,
          selectedLabel,
          disabled,
        }),
        outboundFilter: createOutboundFilter(d, {
          provider: resolved.provider,
          modelId: resolved.modelId,
          purpose,
        }),
        onBlocked: (e) => (blocked = e),
        sessionFile: row.file ? path.join(this.dataDir, row.file) : undefined,
        sessionDir: path.join(this.dataDir, 'ai-sessions'),
      });

      let reply = '';
      let failure: string | undefined;
      this.active.set(sessionId, () => session.abort());
      const onAbort = () => void session.abort();
      signal?.addEventListener('abort', onAbort);
      try {
        await session.prompt(text, (e) => {
          if (e.type === 'text') {
            reply += e.delta;
            emit({ type: 'text', delta: e.delta });
          } else if (e.type === 'tool_start') {
            emit({
              type: 'tool',
              name: e.name,
              label: TOOL_LABEL[e.name] ?? e.name,
              state: 'start',
              args: e.args,
            });
          } else if (e.type === 'tool_end') {
            emit({
              type: 'tool',
              name: e.name,
              label: TOOL_LABEL[e.name] ?? e.name,
              state: e.isError ? 'error' : 'end',
              message: e.isError ? toolErrorText(e.result) : undefined,
            });
          } else if (e.type === 'error') {
            failure = e.message;
          }
        });
      } finally {
        signal?.removeEventListener('abort', onAbort);
        this.active.delete(sessionId);
      }
      const file = session.sessionFile();
      session.dispose();

      if (blocked) failure = `外发被拦截：${(blocked as Error).message}`;
      if (signal?.aborted) reply += reply ? '\n（已停止）' : '（已停止）';
      transcript.push({
        role: 'assistant',
        text: failure ? `${reply}${reply ? '\n' : ''}出错了：${friendlyError(failure)}` : reply,
        cards: run.cards,
        mode: req.mode,
        at: new Date().toISOString(),
      });
      this.saveTranscript(
        sessionId,
        transcript,
        file ? path.relative(this.dataDir, file) : undefined,
      );
      if (failure)
        emit({
          type: 'error',
          message: friendlyError(failure),
          code: blocked ? 'outbound_blocked' : undefined,
        });
      else emit({ type: 'done' });
    } catch (err) {
      const e = err as DomainError;
      emit({ type: 'error', message: e.message || String(err), code: e.code });
    }
  }

  private saveTranscript(id: string, transcript: TranscriptMessage[], file?: string) {
    this.db
      .update(aiSessions)
      .set({ transcript, ...(file ? { file } : {}), updatedAt: new Date().toISOString() })
      .where(eq(aiSessions.id, id))
      .run();
  }

  private selectedLabel(type: string, id: string, guard: OutboundGuard) {
    try {
      const row = this.ai.domain.entity(type).peek(id);
      return row ? guard.sanitize(this.ai.domain.reviewView.displayName(type, row)) : undefined;
    } catch {
      return undefined;
    }
  }
}

function toolErrorText(result: unknown): string {
  const r = result as { content?: { text?: string }[] } | undefined;
  return r?.content?.map((c) => c.text ?? '').join('') || '工具执行失败';
}

/** 把底层错误翻成用户能看懂的话 */
export function friendlyError(msg: string): string {
  if (/401|403|api key|unauthorized|invalid.*key|authentication/i.test(msg))
    return `模型提供方拒绝了请求，请检查 API Key 是否正确、是否有余额。（${msg.slice(0, 120)}）`;
  if (/429|rate.?limit|quota/i.test(msg))
    return `模型提供方提示请求太频繁或额度用完了，稍后再试。（${msg.slice(0, 120)}）`;
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|network|timeout/i.test(msg))
    return `连不上模型服务，请检查网络（本机 Ollama 要确认已启动）。（${msg.slice(0, 120)}）`;
  return msg;
}

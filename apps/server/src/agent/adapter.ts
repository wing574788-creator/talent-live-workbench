/**
 * Pi SDK 适配层：整个后端只有这个目录可以 import Pi（CLAUDE.md 架构铁律 4）。
 * 上游 API 变动只需要改这里。
 */
import fs from 'node:fs';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { AgentEvent } from '@workbench/shared';

export { Type } from 'typebox';

/** 领域工具：工具内部调用领域服务，这里只描述形状。 */
export interface DomainTool {
  name: string;
  label: string;
  description: string;
  /** TypeBox schema，用 `Type.Object({...})` 构造 */
  parameters: ToolDefinition['parameters'];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: (params: any, signal?: AbortSignal) => Promise<unknown>;
}

export interface WorkbenchSessionOptions {
  cwd: string;
  /** Pi 的 agentDir（models.json / auth.json 放这里，指向工作台数据目录，不用 ~/.pi） */
  agentDir: string;
  tools: DomainTool[];
  systemPrompt: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model?: any;
  modelRuntime?: ModelRuntime;
  /** 兜底拦截：返回 string 表示拒绝并给出原因 */
  guard?: (toolName: string, input: unknown) => string | undefined;
  /**
   * 外发过滤：每次请求发给模型提供方之前，对完整请求载荷做脱敏并记录。
   * 失败时`fail-closed`：Pi 会吞掉扩展钩子里的异常并原样发出，所以这里捕获异常后换成一个
   * 无意义的载荷让请求失败，而不是放行原文；原因通过 onBlocked 交给调用方。
   */
  outboundFilter?: (payload: unknown) => unknown | Promise<unknown>;
  onBlocked?: (err: Error) => void;
  /** 继续已有的会话文件（Pi 的 JSONL）；不传则新建（有 sessionDir 时落盘，否则只在内存） */
  sessionFile?: string;
  sessionDir?: string;
}

export interface WorkbenchSession {
  prompt(text: string, onEvent: (e: AgentEvent) => void): Promise<void>;
  abort(): Promise<void>;
  activeToolNames(): string[];
  /** 会话文件路径（有对话内容后才存在） */
  sessionFile(): string | undefined;
  dispose(): void;
}

function toPiTool(tool: DomainTool): ToolDefinition {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    execute: async (_id, params, signal) => {
      const result = await tool.execute(params, signal);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: {} };
    },
  } as ToolDefinition;
}

export async function createWorkbenchSession(
  opts: WorkbenchSessionOptions,
): Promise<WorkbenchSession> {
  const names = opts.tools.map((t) => t.name);
  const allow = new Set(names);

  // 不读 ~/.pi 与项目目录下的扩展、技能、提示词模板、上下文文件。
  const resourceLoader = new DefaultResourceLoader({
    cwd: opts.cwd,
    agentDir: opts.agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: opts.systemPrompt,
    extensionFactories: [
      (pi) => {
        if (opts.outboundFilter) {
          const filter = opts.outboundFilter;
          pi.on('before_provider_request', async (event) => {
            try {
              return await filter(event.payload);
            } catch (err) {
              const e = err instanceof Error ? err : new Error(String(err));
              opts.onBlocked?.(e);
              return { blocked: '外发被本地过滤器拦截，请求没有发出' };
            }
          });
        }
        // 白名单 + 自定义守卫（限流等）
        pi.on('tool_call', (event) => {
          if (!allow.has(event.toolName)) {
            return { block: true, reason: `工具 ${event.toolName} 不在白名单内` };
          }
          const reason = opts.guard?.(event.toolName, event.input);
          if (reason) return { block: true, reason };
          return undefined;
        });
      },
    ],
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: opts.cwd,
    agentDir: opts.agentDir,
    model: opts.model,
    modelRuntime: opts.modelRuntime,
    thinkingLevel: 'off',
    resourceLoader,
    // 双保险：noTools 关掉内置工具，tools 白名单只放领域工具
    noTools: 'builtin',
    tools: names,
    customTools: opts.tools.map(toPiTool),
    sessionManager:
      opts.sessionFile && fs.existsSync(opts.sessionFile)
        ? SessionManager.open(opts.sessionFile, undefined, opts.cwd)
        : opts.sessionDir
          ? SessionManager.create(opts.cwd, opts.sessionDir)
          : SessionManager.inMemory(opts.cwd),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
  });

  return {
    async prompt(text, onEvent) {
      // 提供方返回错误（密钥无效、额度用完、网络不通）时 Pi 不抛异常，而是在助手消息上标记 error
      let providerError: string | undefined;
      const unsubscribe = session.subscribe((event) => {
        if (
          event.type === 'message_end' &&
          event.message.role === 'assistant' &&
          event.message.stopReason === 'error'
        ) {
          providerError = event.message.errorMessage ?? '模型请求失败';
        }
        if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
          onEvent({ type: 'text', delta: event.assistantMessageEvent.delta });
        } else if (event.type === 'tool_execution_start') {
          onEvent({ type: 'tool_start', name: event.toolName, args: event.args });
        } else if (event.type === 'tool_execution_end') {
          onEvent({
            type: 'tool_end',
            name: event.toolName,
            result: event.result,
            isError: event.isError,
          });
        }
      });
      try {
        await session.prompt(text);
        if (providerError) onEvent({ type: 'error', message: providerError });
        else onEvent({ type: 'done' });
      } catch (err) {
        onEvent({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      } finally {
        unsubscribe();
      }
    },
    abort: () => session.abort(),
    activeToolNames: () => session.getActiveToolNames(),
    sessionFile: () => session.sessionManager.getSessionFile(),
    dispose: () => session.dispose(),
  };
}

import os from 'node:os';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@workbench/shared';
import { createWorkbenchSession, Type, type DomainTool } from './adapter.ts';
import { createFauxModel, fauxAssistantMessage, fauxText, fauxToolCall } from './faux.ts';

function makeTools(calls: string[]): DomainTool[] {
  return [
    {
      name: 'echo_tool',
      label: '回显',
      description: '原样返回 text',
      parameters: Type.Object({ text: Type.String() }),
      execute: async (p) => {
        calls.push(`echo_tool:${p.text}`);
        return { echoed: p.text };
      },
    },
    {
      name: 'slow_tool',
      label: '慢工具',
      description: '等待直到被中止',
      parameters: Type.Object({}),
      execute: (_p, signal) =>
        new Promise((_res, rej) => {
          calls.push('slow_tool:start');
          signal?.addEventListener('abort', () => rej(new Error('aborted')));
        }),
    },
  ];
}

async function setup(guard?: (n: string, i: unknown) => string | undefined) {
  const calls: string[] = [];
  const { faux, model, modelRuntime, agentDir } = await createFauxModel();
  const session = await createWorkbenchSession({
    cwd: os.tmpdir(),
    agentDir,
    modelRuntime,
    tools: makeTools(calls),
    systemPrompt: '测试',
    model,
    guard,
  });
  return { calls, faux, session };
}

async function run(session: Awaited<ReturnType<typeof setup>>['session'], text: string) {
  const events: AgentEvent[] = [];
  await session.prompt(text, (e) => events.push(e));
  return events;
}

describe('Pi 适配层', () => {
  it('内置工具关闭，只剩领域工具', async () => {
    const { session } = await setup();
    expect(session.activeToolNames().sort()).toEqual(['echo_tool', 'slow_tool']);
    session.dispose();
  });

  it('调用自定义工具并流式返回文本', async () => {
    const { calls, faux, session } = await setup();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('echo_tool', { text: '你好' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage(fauxText('完成')),
    ]);
    const events = await run(session, '回显一下');
    expect(calls).toEqual(['echo_tool:你好']);
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['tool_start', 'tool_end', 'text', 'done']),
    );
    session.dispose();
  });

  it('tool_call 拦截在 SDK 模式下生效：被守卫拒绝的调用不会执行', async () => {
    const { calls, faux, session } = await setup((name) =>
      name === 'echo_tool' ? '测试拒绝' : undefined,
    );
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('echo_tool', { text: 'x' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxText('好的')),
    ]);
    const events = await run(session, 'go');
    expect(calls).toEqual([]);
    const end = events.find((e) => e.type === 'tool_end');
    expect(end && end.type === 'tool_end' && end.isError).toBe(true);
    session.dispose();
  });

  it('白名单之外的工具（如 bash）不会执行', async () => {
    const { calls, faux, session } = await setup();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('bash', { command: 'echo hi' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage(fauxText('好的')),
    ]);
    const events = await run(session, 'go');
    expect(calls).toEqual([]);
    const end = events.find((e) => e.type === 'tool_end');
    expect(end && end.type === 'tool_end' && end.isError).toBe(true);
    session.dispose();
  });

  it('abort() 能中止正在执行的工具', async () => {
    const { calls, faux, session } = await setup();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('slow_tool', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxText('不应到这里')),
    ]);
    const events: AgentEvent[] = [];
    const running = session.prompt('go', (e) => events.push(e));
    await new Promise((r) => setTimeout(r, 300));
    expect(calls).toContain('slow_tool:start');
    await session.abort();
    await running;
    expect(events.some((e) => e.type === 'text' && e.delta.includes('不应到这里'))).toBe(false);
    session.dispose();
  });
});

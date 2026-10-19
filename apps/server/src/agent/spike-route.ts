/** 阶段 0 技术验证用的 SSE 端点：假模型 + 一个回显工具。阶段 7 由正式聊天路由取代。 */
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AgentEvent } from '@workbench/shared';
import { createWorkbenchSession, Type } from './adapter.ts';
import { createFauxModel, fauxAssistantMessage, fauxText, fauxToolCall } from './faux.ts';

export const spikeRoutes = new Hono().get('/api/agent/spike', (c) =>
  streamSSE(c, async (stream) => {
    const { faux, model, modelRuntime, agentDir } = await createFauxModel();
    const session = await createWorkbenchSession({
      cwd: agentDir,
      agentDir,
      model,
      modelRuntime,
      systemPrompt: '你是工作台助手（spike）。',
      tools: [
        {
          name: 'echo_tool',
          label: '回显',
          description: '原样返回 text',
          parameters: Type.Object({ text: Type.String() }),
          execute: async (p) => ({ echoed: p.text }),
        },
      ],
    });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('echo_tool', { text: '你好，工作台' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage(fauxText('工具已调用，结果见上。这是一段用于验证流式输出的文字。')),
    ]);
    stream.onAbort(() => void session.abort());
    await session.prompt('演示一次工具调用', (e: AgentEvent) => {
      void stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
    });
    session.dispose();
  }),
);

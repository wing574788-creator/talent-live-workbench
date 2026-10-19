/** 测试 / spike 用的脚本化假模型，不联网、不需要 API Key。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  fauxProvider,
} from '@earendil-works/pi-ai/compat';

export { fauxAssistantMessage, fauxText, fauxToolCall };

/**
 * simulatePayload：像真实提供方一样，在"发送"前调用 onPayload（外发过滤钩子），
 * 并把钩子返回的、真正会被发出去的载荷记在 sent 里，测试用它检查外发内容。
 */
export async function createFauxModel(opts: { simulatePayload?: boolean } = {}) {
  const faux = fauxProvider({ tokensPerSecond: 2000 });
  const sent: unknown[] = [];
  const model = faux.getModel();
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-pi-'));
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, 'auth.json'),
    modelsPath: path.join(agentDir, 'models.json'),
    refreshOnCreate: false,
  });
  if (opts.simulatePayload) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wrap = (fn: any) => (m: any, context: any, o: any) => {
      const out = createAssistantMessageEventStream();
      void (async () => {
        const raw = {
          model: m.id,
          system: context.systemPrompt,
          messages: context.messages,
          tools: context.tools,
        };
        const payload = (await o?.onPayload?.(raw, m)) ?? raw;
        sent.push(payload);
        const inner = fn(m, context, o);
        for await (const ev of inner) out.push(ev);
        out.end(await inner.result());
      })();
      return out;
    };
    modelRuntime.registerNativeProvider({
      ...faux.provider,
      stream: wrap(faux.provider.stream),
      streamSimple: wrap(faux.provider.streamSimple),
    });
  } else {
    modelRuntime.registerNativeProvider(faux.provider);
  }
  await modelRuntime.setRuntimeApiKey(model.provider, 'faux-key');
  return { faux, model, modelRuntime, agentDir, sent };
}

/**
 * 本地假的 OpenAI 兼容接口：测试和手动演示用（不联网、不需要真实 API Key）。
 * 按脚本逐次回复，并记录收到的每个请求体，方便检查"实际发出去的内容"。
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockReply {
  /** 返回 HTTP 错误（如 401、429） */
  status?: number;
  text?: string;
  toolCalls?: { name: string; args: Record<string, unknown> }[];
}
/** 脚本：数组按顺序用；函数则根据请求内容决定 */
export type MockScript = MockReply[] | ((body: Record<string, any>, n: number) => MockReply); // eslint-disable-line @typescript-eslint/no-explicit-any

export interface MockServer {
  url: string;
  requests: Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  setScript(s: MockScript): void;
  close(): Promise<void>;
}

export async function startMockOpenAI(
  initial: MockScript = [],
  listenPort = 0,
): Promise<MockServer> {
  let script = initial;
  const requests: Record<string, any>[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  let n = 0;
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(body);
      const i = n++;
      const reply: MockReply =
        typeof script === 'function' ? script(body, i) : (script[i] ?? { text: '（脚本用完了）' });
      if (reply.status) {
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: reply.text ?? 'error', type: 'mock_error' } }));
        return;
      }
      const send = (delta: Record<string, unknown>, finish: string | null = null) =>
        res.write(
          `data: ${JSON.stringify({ id: `mock-${i}`, object: 'chat.completion.chunk', created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      send({ role: 'assistant', content: '' });
      if (reply.text)
        for (let k = 0; k < reply.text.length; k += 6)
          send({ content: reply.text.slice(k, k + 6) });
      (reply.toolCalls ?? []).forEach((t, idx) =>
        send({
          tool_calls: [
            {
              index: idx,
              id: `call_${i}_${idx}`,
              type: 'function',
              function: { name: t.name, arguments: JSON.stringify(t.args) },
            },
          ],
        }),
      );
      send({}, reply.toolCalls?.length ? 'tool_calls' : 'stop');
      res.write(
        `data: ${JSON.stringify({ id: `mock-${i}`, object: 'chat.completion.chunk', created: 0, model: body.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`,
      );
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(listenPort, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    setScript: (s) => {
      script = s;
      n = 0;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}

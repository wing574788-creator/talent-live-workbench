/** 读取后端的 SSE 对话流（POST，所以不能用 EventSource） */
export type ChatEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'text'; delta: string }
  | {
      type: 'tool';
      name: string;
      label: string;
      state: 'start' | 'end' | 'error';
      message?: string;
    }
  | { type: 'card'; card: AiCard }
  | { type: 'done' }
  | { type: 'error'; message: string; code?: string };

export interface AiCard {
  id: string;
  kind: 'pending' | 'applied' | 'choose' | 'batch';
  title: string;
  entity?: string;
  entityId?: string;
  pendingId?: string;
  logId?: string;
  batchId?: string;
  lines?: string[];
  warnings?: string[];
  question?: string;
  candidates?: { id: string; type: string; label: string; detail?: string }[];
  count?: number;
}

export interface ChatBody {
  sessionId?: string;
  text: string;
  mode: 'extract' | 'chat';
  confirmed?: string[];
  context?: { page?: string; selected?: { type: string; id: string } };
  note?: string;
  carryText?: string;
  sourceAttachmentId?: string;
}

export async function streamChat(
  body: ChatBody,
  onEvent: (e: ChatEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/ai/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    onEvent({ type: 'error', message: `请求失败（${res.status}）` });
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (data) onEvent(JSON.parse(data) as ChatEvent);
    }
  }
}

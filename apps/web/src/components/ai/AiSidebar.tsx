import { useQuery } from '@tanstack/react-query';
import { Link, useRouterState } from '@tanstack/react-router';
import { NAV_ITEMS } from '@workbench/shared';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, uploadFile } from '../../lib/api.ts';
import { streamChat, type AiCard, type ChatBody, type ChatEvent } from '../../lib/aiStream.ts';
import { fieldLabel } from '../../lib/labels.ts';
import { useSelected } from '../../lib/selection.ts';
import { DiffTable, type FieldDiff } from '../Diff.tsx';
import { useAction } from '../detail.tsx';
import { Badge, Button, Modal, Textarea, cx, useToast } from '../ui.tsx';
import { useAiPanel } from './AiPanel.tsx';
import { useAiConfig } from './AiSettings.tsx';
import { useOpenRecord } from './RecordHost.tsx';

interface UiMessage {
  role: 'user' | 'assistant';
  text: string;
  cards: AiCard[];
  /** 正在执行的工具名（流式过程中显示） */
  working?: string;
  error?: string;
  note?: string;
}

type Mode = 'extract' | 'chat';
const STORE_KEY = 'ai-session';

const readStore = () => {
  try {
    return localStorage.getItem(STORE_KEY);
  } catch {
    return null;
  }
};
const writeStore = (id: string | null) => {
  try {
    if (id) localStorage.setItem(STORE_KEY, id);
    else localStorage.removeItem(STORE_KEY);
  } catch {
    /* 隐私模式等情况下忽略 */
  }
};

export function AiSidebar({ onClose }: { onClose: () => void }) {
  const cfg = useAiConfig();
  const panel = useAiPanel();
  const selected = useSelected();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const [mode, setMode] = useState<Mode>('extract');
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const sessionRef = useRef<string | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const lastUserText = useRef('');
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [shot, setShot] = useState<{ text: string; engine: string; attachmentId: string } | null>(
    null,
  );
  const [reading, setReading] = useState(false);

  /** 截图先在本机识别成文字；图片不会发给模型，文字由你确认后才发送 */
  async function readScreenshot(file: File) {
    setReading(true);
    try {
      const res = await uploadFile('/ai/ocr', file);
      setShot({ text: res.text, engine: res.engine, attachmentId: res.attachmentId });
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setReading(false);
    }
  }

  // 恢复上次的会话
  useEffect(() => {
    const id = readStore();
    if (!id) return;
    api<{
      id: string;
      transcript: { role: 'user' | 'assistant'; text: string; cards?: AiCard[]; note?: string }[];
    }>('GET', `/ai/sessions/${id}`)
      .then((s) => {
        sessionRef.current = s.id;
        setMessages(
          s.transcript.map((m) => ({
            role: m.role,
            text: m.text,
            cards: m.cards ?? [],
            note: m.note,
          })),
        );
      })
      .catch(() => writeStore(null));
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  async function send(
    text: string,
    opts: {
      mode?: Mode;
      confirmed?: string[];
      carryText?: string;
      note?: string;
      sourceAttachmentId?: string;
    } = {},
  ) {
    const t = text.trim();
    if (!t || busy) return;
    const m = opts.mode ?? mode;
    if (opts.mode) setMode(opts.mode);
    lastUserText.current = opts.carryText ? opts.carryText : t;
    setMessages((cur) => [
      ...cur,
      { role: 'user', text: t, cards: [], note: opts.note },
      { role: 'assistant', text: '', cards: [] },
    ]);
    setInput('');
    setBusy(true);
    const ac = new AbortController();
    abortRef.current = ac;
    const patchLast = (fn: (m: UiMessage) => UiMessage) =>
      setMessages((cur) => cur.map((x, i) => (i === cur.length - 1 ? fn(x) : x)));
    const body: ChatBody = {
      sessionId: sessionRef.current,
      text: t,
      mode: m,
      confirmed: opts.confirmed,
      carryText: opts.carryText,
      sourceAttachmentId: opts.sourceAttachmentId,
      note: opts.note,
      context: {
        page: NAV_ITEMS.find((n) => n.path === path)?.label,
        selected: selected ?? undefined,
      },
    };
    const onEvent = (e: ChatEvent) => {
      if (e.type === 'session') {
        sessionRef.current = e.sessionId;
        writeStore(e.sessionId);
      } else if (e.type === 'text')
        patchLast((x) => ({ ...x, text: x.text + e.delta, working: undefined }));
      else if (e.type === 'tool')
        patchLast((x) => ({ ...x, working: e.state === 'start' ? e.label : undefined }));
      else if (e.type === 'card') patchLast((x) => ({ ...x, cards: [...x.cards, e.card] }));
      else if (e.type === 'error')
        patchLast((x) => ({ ...x, error: e.message, working: undefined }));
    };
    try {
      await streamChat(body, onEvent, ac.signal);
    } catch (err) {
      if ((err as Error).name !== 'AbortError')
        patchLast((x) => ({ ...x, error: (err as Error).message }));
    } finally {
      patchLast((x) => ({
        ...x,
        working: undefined,
        text: ac.signal.aborted && !x.text ? '（已停止）' : x.text,
      }));
      setBusy(false);
      abortRef.current = null;
    }
  }

  // 首页的一句话录入
  useEffect(() => {
    if (!panel.request || busy) return;
    const r = panel.request;
    panel.consume();
    void send(r.text, { mode: r.mode ?? 'extract' });
  }, [panel.request]);

  function reset() {
    abortRef.current?.abort();
    sessionRef.current = undefined;
    writeStore(null);
    setMessages([]);
  }

  const choose = (c: { id: string; label: string }) =>
    send(`我选的是「${c.label}」，请继续刚才的处理。`, {
      confirmed: [c.id],
      carryText: lastUserText.current,
    });

  const configured = cfg.data?.configured ?? true;
  return (
    <aside
      aria-label="AI 助手"
      className="sticky top-0 flex h-screen w-96 shrink-0 flex-col border-l border-line bg-surface"
    >
      <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-4">
        <h2 className="m-0 text-base font-bold">AI 助手</h2>
        <div className="flex gap-1.5">
          <Button className="!min-h-8 !px-2.5" onClick={reset} disabled={!messages.length}>
            新对话
          </Button>
          <Button className="!min-h-8 !px-2.5" onClick={onClose}>
            收起
          </Button>
        </div>
      </div>

      <div className="mx-4 flex rounded-2xl bg-bg p-1" role="tablist" aria-label="模式">
        {(
          [
            ['extract', '录入'],
            ['chat', '问答'],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            role="tab"
            aria-selected={mode === k}
            type="button"
            onClick={() => setMode(k)}
            className={cx(
              'min-h-8 flex-1 cursor-pointer rounded-xl border-0 text-sm',
              mode === k
                ? 'bg-surface font-medium text-brand shadow-sm'
                : 'bg-transparent text-muted',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="mx-4 mb-0 mt-1.5 text-xs text-muted">
        {mode === 'extract'
          ? '粘贴聊天记录或一句话，AI 整理成改动卡片；修改类的改动要你确认后才生效。'
          : '只查询、不改数据，回答里的名字可以点开查看。'}
      </p>

      {!configured && (
        <div className="mx-4 mt-3 rounded-2xl bg-brand-soft px-4 py-3 text-[13px]">
          还没有配置 AI 模型。到{' '}
          <Link to="/settings" className="text-brand">
            设置 → AI 模型
          </Link>{' '}
          添加提供方并填入 API Key 后即可使用，其余功能不受影响。
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {messages.length === 0 && (
          <div className="text-[13px] leading-6 text-muted">
            试试：
            <ul className="my-1 list-disc pl-5">
              <li>刚和小美的经纪人聊了，佣金 25 个点，下周三播，样衣明天寄 S、M 各一件</li>
              <li>（问答）签收超过两周还没开播的有哪些？</li>
            </ul>
            手机号、微信号、地址、真实姓名发给模型前会在本机脱敏；图片不会发给模型。
          </div>
        )}
        {messages.map((m, i) => (
          <MessageView
            key={i}
            m={m}
            onChoose={choose}
            streaming={busy && i === messages.length - 1}
          />
        ))}
        <div ref={endRef} />
      </div>

      <form
        className="border-t border-line p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        {selected && (
          <div className="mb-1.5 text-xs text-muted">
            当前选中：
            {
              { influencer: '达人', cooperation: '合作', product: '商品', contact: '联系人' }[
                selected.type
              ]
            }
            （打开的详情）
          </div>
        )}
        <Textarea
          rows={3}
          aria-label="给 AI 的内容"
          placeholder={
            mode === 'extract'
              ? '粘贴聊天记录，或一句话说明…'
              : '问点什么，例如：哪些样衣逾期没寄回？'
          }
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onPaste={(e) => {
            const img = [...e.clipboardData.files].find((f) => f.type.startsWith('image/'));
            if (img) {
              e.preventDefault();
              void readScreenshot(img);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send(input);
            }
          }}
          disabled={busy}
        />
        <div className="mt-2 flex items-center justify-end gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            aria-label="上传截图"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void readScreenshot(f);
            }}
          />
          <Button
            disabled={busy || reading}
            onClick={() => fileRef.current?.click()}
            title="上传或直接粘贴聊天截图，先在本机识别成文字"
          >
            {reading ? '识别中…' : '截图'}
          </Button>
          <span className="flex-1" />
          {busy ? (
            <Button variant="danger" onClick={() => abortRef.current?.abort()}>
              停止
            </Button>
          ) : (
            <Button variant="primary" type="submit" disabled={!input.trim()}>
              发送
            </Button>
          )}
        </div>
      </form>
      {shot && (
        <Modal
          title="截图识别结果"
          width={620}
          onClose={() => setShot(null)}
          footer={
            <>
              <Button onClick={() => setShot(null)}>取消</Button>
              <Button
                variant="primary"
                disabled={!shot.text.trim() || busy}
                onClick={() => {
                  const s = shot;
                  setShot(null);
                  void send(s.text, {
                    mode: 'extract',
                    note: `来自截图识别（${s.engine}）`,
                    sourceAttachmentId: s.attachmentId,
                  });
                }}
              >
                发送给 AI
              </Button>
            </>
          }
        >
          <p className="mt-0 text-[13px] text-muted">
            截图已在本机用「{shot.engine}
            」识别成下面的文字，图片本身不会发给模型。识别可能有错字，请核对数字（佣金、金额、日期）后再发送；手机号、微信号、地址发出前仍会自动脱敏。
          </p>
          <Textarea
            rows={10}
            aria-label="识别出的文字"
            value={shot.text}
            onChange={(e) => setShot({ ...shot, text: e.target.value })}
          />
        </Modal>
      )}
    </aside>
  );
}

// ───────────── 消息 ─────────────
const LINK = /\[([^\]]+)\]\(wb:(\w+):([^)\s]+)\)/g;

/** 回答里的 [名称](wb:类型:ID) 渲染成可点击的记录链接 */
export function RichText({ text }: { text: string }) {
  const open = useOpenRecord();
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(LINK)) {
    if (m.index! > last) parts.push(text.slice(last, m.index));
    parts.push(
      <button
        key={m.index}
        type="button"
        className="cursor-pointer border-0 bg-transparent p-0 text-brand underline"
        onClick={() => open(m[2]!, m[3]!)}
      >
        {m[1]}
      </button>,
    );
    last = m.index! + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return (
    <span className="whitespace-pre-wrap">
      {parts.map((p, i) => (
        <Fragment key={i}>{p}</Fragment>
      ))}
    </span>
  );
}

function MessageView({
  m,
  onChoose,
  streaming,
}: {
  m: UiMessage;
  onChoose: (c: { id: string; label: string }) => void;
  streaming: boolean;
}) {
  if (m.role === 'user') {
    return (
      <div className="mb-3 flex flex-col items-end">
        {m.note && <span className="mb-0.5 text-xs text-muted">{m.note}</span>}
        <div className="max-w-[90%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-brand px-3.5 py-2.5 text-sm text-white">
          {m.text}
        </div>
      </div>
    );
  }
  return (
    <div className="mb-4 flex flex-col gap-2">
      {m.text && (
        <div className="text-sm leading-6">
          <RichText text={m.text} />
        </div>
      )}
      {streaming && !m.text && !m.working && !m.cards.length && (
        <span className="text-[13px] text-muted">思考中…</span>
      )}
      {m.working && <span className="text-[13px] text-muted">正在{m.working}…</span>}
      {m.cards.map((c) => (
        <CardView key={c.id} card={c} onChoose={onChoose} />
      ))}
      {m.error && (
        <div role="alert" className="rounded-2xl bg-warn-soft px-4 py-2.5 text-[13px] text-warn">
          {m.error}
        </div>
      )}
    </div>
  );
}

// ───────────── 卡片 ─────────────
function CardView({
  card,
  onChoose,
}: {
  card: AiCard;
  onChoose: (c: { id: string; label: string }) => void;
}) {
  if (card.kind === 'choose') return <ChooseCard card={card} onChoose={onChoose} />;
  if (card.kind === 'pending') return <PendingCardView card={card} />;
  if (card.kind === 'batch') return <BatchCard card={card} />;
  return <AppliedCard card={card} />;
}

const box = 'rounded-2xl bg-bg px-4 py-3 text-[13px]';

function Warnings({ items }: { items?: string[] }) {
  if (!items?.length) return null;
  return (
    <ul
      role="alert"
      className="m-0 mt-1.5 list-none rounded-xl bg-amber-soft px-3 py-1.5 text-[#8a4b00]"
    >
      {items.map((w) => (
        <li key={w}>⚠ {w}</li>
      ))}
    </ul>
  );
}

function AppliedCard({ card }: { card: AiCard }) {
  const run = useAction();
  const [undone, setUndone] = useState(false);
  return (
    <div className={box}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <Badge tone="green">已写入</Badge> <b>{card.title}</b>
        </div>
        {undone ? (
          <span className="text-muted">已撤销</span>
        ) : (
          <Button
            className="!min-h-7 !px-2"
            onClick={async () => {
              const ok = await run(
                () =>
                  card.entity === 'follow_up' && card.logId
                    ? api('POST', `/changes/${card.logId}/undo`)
                    : api('POST', `/batches/${card.batchId}/undo`),
                '已撤销',
              );
              if (ok) setUndone(true);
            }}
          >
            撤销
          </Button>
        )}
      </div>
      <ul className="m-0 mt-1 list-none p-0 text-ink-2">
        {card.lines?.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      <Warnings items={card.warnings} />
    </div>
  );
}

function BatchCard({ card }: { card: AiCard }) {
  return (
    <div className={box}>
      <Badge tone="orange">待审核</Badge> <b>{card.title}</b>
      <ul className="m-0 mt-1 list-none p-0 text-ink-2">
        {card.lines?.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      <Warnings items={card.warnings} />
      <div className="mt-2">
        <Link to="/review" className="text-brand">
          去审核页整批通过或驳回 →
        </Link>
      </div>
    </div>
  );
}

function ChooseCard({
  card,
  onChoose,
}: {
  card: AiCard;
  onChoose: (c: { id: string; label: string }) => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <div className={box}>
      <div className="mb-1.5 font-medium">{card.question ?? card.title}</div>
      <div className="flex flex-col gap-1.5">
        {card.candidates?.map((c) => (
          <button
            key={c.id}
            type="button"
            disabled={!!picked}
            onClick={() => {
              setPicked(c.id);
              onChoose(c);
            }}
            className={cx(
              'cursor-pointer rounded-xl border bg-surface px-3 py-2 text-left disabled:cursor-default',
              picked === c.id ? 'border-brand text-brand' : 'border-line-strong',
              !!picked && picked !== c.id && 'opacity-50',
            )}
          >
            <b>{c.label}</b>
            {c.detail && <span className="ml-2 text-muted">{c.detail}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

interface Pending {
  id: string;
  entity: string;
  reason: string;
  stale: boolean;
  staleReason: string | null;
  diff: FieldDiff[];
  warnings: string[];
  target: string;
}

/** 把输入框里的文字转成字段要的值 */
function parseInput(field: string, raw: string): unknown {
  const v = raw.trim();
  if (v === '') return null;
  if (field.endsWith('Cents')) return Math.round(Number(v.replace(/[¥,，]/g, '')) * 100);
  if (field === 'commissionPct' || field === 'refCommissionPct') return Number(v);
  if (field === 'categoryTags' || field === 'styleTags')
    return v.split(/[,，、\s]+/).filter(Boolean);
  return v;
}
function initialInput(field: string, v: unknown): string {
  if (v == null) return '';
  if (field.endsWith('Cents') && typeof v === 'number') return String(v / 100);
  if (Array.isArray(v)) return v.join('、');
  return String(v);
}

/** 待审核改动：可以直接改字段，再通过 / 驳回 */
function PendingCardView({ card }: { card: AiCard }) {
  const run = useAction();
  const toast = useToast();
  const q = useQuery({
    queryKey: ['review-pending'],
    queryFn: () => api<{ rows: Pending[] }>('GET', '/review/pending'),
  });
  const [state, setState] = useState<'approved' | 'rejected' | null>(null);
  const [editing, setEditing] = useState<Record<string, string> | null>(null);
  const p = q.data?.rows.find((r) => r.id === card.pendingId);
  const handled = state ?? (q.data && !p ? 'handled' : null);

  if (handled) {
    return (
      <div className={box}>
        <Badge>
          {handled === 'approved' ? '已通过' : handled === 'rejected' ? '已驳回' : '已处理'}
        </Badge>{' '}
        <b>{card.title}</b>
      </div>
    );
  }
  if (!p) return <div className={box}>{card.title}…</div>;

  const startEdit = () =>
    setEditing(Object.fromEntries(p.diff.map((d) => [d.field, initialInput(d.field, d.after)])));
  async function saveEdit() {
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(editing!)) {
      const parsed = parseInput(k, v);
      if (typeof parsed === 'number' && Number.isNaN(parsed))
        return toast(`${fieldLabel(k)} 需要填数字`, 'error');
      patch[k] = parsed;
    }
    if (await run(() => api('PATCH', `/review/${p!.id}`, { patch }), '已修改')) setEditing(null);
  }

  return (
    <div className={box}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone="orange">待审核</Badge>
        <b>{card.title}</b>
      </div>
      <div className="text-muted">{p.reason}</div>
      {editing ? (
        <div className="mt-2 flex flex-col gap-1.5">
          {p.diff.map((d) => (
            <label key={d.field} className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-muted">{fieldLabel(d.field)}</span>
              <input
                aria-label={fieldLabel(d.field)}
                type={/Date$/.test(d.field) ? 'date' : 'text'}
                className="min-h-8 w-full rounded-xl border border-line-strong bg-surface px-2"
                value={editing[d.field] ?? ''}
                onChange={(e) => setEditing({ ...editing, [d.field]: e.target.value })}
              />
            </label>
          ))}
          <div className="flex gap-2">
            <Button variant="primary" className="!min-h-8" onClick={saveEdit}>
              保存修改
            </Button>
            <Button className="!min-h-8" onClick={() => setEditing(null)}>
              取消
            </Button>
          </div>
        </div>
      ) : (
        <DiffTable diff={p.diff} />
      )}
      <Warnings items={p.warnings} />
      {p.stale && <div className="mt-1.5 text-warn">{p.staleReason}，请到审核页重新确认。</div>}
      {!editing && (
        <div className="mt-2 flex flex-wrap gap-2">
          {!p.stale && (
            <Button
              variant="primary"
              className="!min-h-8"
              onClick={async () =>
                (await run(() => api('POST', `/review/${p.id}/approve`), '已通过')) &&
                setState('approved')
              }
            >
              通过
            </Button>
          )}
          {p.diff.length > 0 && !p.stale && (
            <Button className="!min-h-8" onClick={startEdit}>
              修改后再通过
            </Button>
          )}
          <Button
            className="!min-h-8"
            onClick={async () =>
              (await run(() => api('POST', `/review/${p.id}/reject`), '已驳回')) &&
              setState('rejected')
            }
          >
            驳回
          </Button>
        </div>
      )}
    </div>
  );
}

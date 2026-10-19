import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../lib/api.ts';
import { fmtDateTime } from '../../lib/format.ts';
import { Button, Textarea } from '../ui.tsx';
import { useAiPanel } from './AiPanel.tsx';
import { RichText } from './AiSidebar.tsx';

interface SummaryRes {
  available: boolean;
  message?: string;
  error?: string | null;
  content?: string | null;
  cached?: boolean;
  generatedAt?: string;
}

/** 今日概况：有 AI 摘要用 AI 的（按天缓存，可重新生成）；没配置或失败时显示按规则生成的要点 */
export function SummaryCard({ highlights }: { highlights: string[] }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['ai-summary'],
    queryFn: () => api<SummaryRes>('GET', '/ai/summary'),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const [busy, setBusy] = useState(false);
  const s = q.data;
  const lines = s?.content
    ?.split('\n')
    .map((l) => l.replace(/^\s*[-*•]\s*/, '').trim())
    .filter(Boolean);

  async function regenerate() {
    setBusy(true);
    try {
      qc.setQueryData(['ai-summary'], await api<SummaryRes>('GET', '/ai/summary?refresh=1'));
    } finally {
      setBusy(false);
    }
  }

  const bullets = lines?.length ? lines : highlights;
  return (
    <section aria-label="今日概况" className="rounded-[28px] bg-ink px-6 py-5 text-white">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 text-[15px] font-extrabold">
          <span className="flex size-7 items-center justify-center rounded-[10px] bg-lime">
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="#16152b">
              <path d="M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4z" />
            </svg>
          </span>
          今日概况{lines?.length ? ' · AI 摘要' : ''}
        </div>
        {s?.available && (
          <Button
            className="!min-h-8 !border-[#4a4970] !bg-transparent !px-3 !text-xs !text-[#e6e5f5] hover:!bg-white/10"
            disabled={busy || q.isFetching}
            onClick={regenerate}
          >
            {busy ? '生成中…' : '重新生成'}
          </Button>
        )}
      </div>
      {q.isFetching && !s ? (
        <p className="mb-0 mt-3 text-[#a9a8c8]">AI 正在整理今天的概况…</p>
      ) : bullets.length ? (
        <ul className="m-0 mt-3 flex list-none flex-col gap-3 p-0 text-[15px] leading-relaxed">
          {bullets.map((l, i) => (
            <li key={l} className="flex gap-3">
              <span
                className="mt-2.5 size-2 shrink-0 rounded-full"
                style={{ background: ['#ff6f59', '#c8f560', '#8e88ff'][i % 3] }}
              />
              <span className="[&_button]:!text-lime">
                <RichText text={l} />
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-0 mt-3 text-[#a9a8c8]">暂时没有需要特别留意的事。</p>
      )}
      <p className="mb-0 mt-3 text-xs text-[#a9a8c8]">
        {lines?.length
          ? `${s?.cached ? '今天已生成过，' : ''}${s?.generatedAt ? fmtDateTime(s.generatedAt) + ' 生成；' : ''}发给模型的只有昵称、阶段、天数等摘要信息。`
          : s?.error
            ? `AI 摘要暂时不可用（${s.error}），先显示按规则生成的概况。`
            : s?.available === false
              ? `按规则生成。${s.message ?? ''}`
              : '按规则生成。'}
      </p>
    </section>
  );
}

/** 首页的一句话录入：把内容交给 AI 侧栏处理 */
export function QuickEntry() {
  const { ask } = useAiPanel();
  const [text, setText] = useState('');
  return (
    <form
      aria-label="一句话录入"
      className="rounded-[28px] bg-surface px-6 py-5 shadow-[0_1px_0_var(--color-line)]"
      onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim()) return;
        ask(text.trim(), 'extract');
        setText('');
      }}
    >
      <div className="mb-2 text-[13px] font-medium text-brand">一句话录入</div>
      <div className="flex items-end gap-3">
        <Textarea
          rows={2}
          aria-label="一句话录入内容"
          placeholder="例如：刚和小美的经纪人聊了，佣金 25 个点，下周三播，样衣明天寄 S、M 各一件"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <Button variant="primary" type="submit" disabled={!text.trim()}>
          交给 AI
        </Button>
      </div>
      <p className="mb-0 mt-2 text-xs text-muted">
        AI 会整理成改动卡片，在右侧确认；修改金额、佣金、阶段等要你确认后才生效。
      </p>
    </form>
  );
}

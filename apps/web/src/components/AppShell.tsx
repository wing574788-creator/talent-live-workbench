import { useQuery } from '@tanstack/react-query';
import { Link, Outlet } from '@tanstack/react-router';
import { NAV_ITEMS } from '@workbench/shared';
import type { ReactNode } from 'react';
import { AiPanelProvider, useAiPanel } from './ai/AiPanel.tsx';
import { AiSidebar } from './ai/AiSidebar.tsx';
import { RecordHost } from './ai/RecordHost.tsx';

const navBase =
  'flex min-h-11 items-center justify-between rounded-2xl px-3.5 text-sm no-underline transition-colors';

const svg = (children: ReactNode) => (
  <svg
    aria-hidden="true"
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {children}
  </svg>
);

/** 导航图标（线条风格，当前页自动变成荧光绿） */
const ICONS: Record<string, ReactNode> = {
  home: svg(<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />),
  cooperations: svg(
    <>
      <rect x="3" y="3" width="5" height="18" rx="1.5" />
      <rect x="10" y="3" width="5" height="12" rx="1.5" />
      <rect x="17" y="3" width="4" height="8" rx="1.5" />
    </>,
  ),
  influencers: svg(
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c.6-3.4 3.3-5.5 6.5-5.5s5.9 2.1 6.5 5.5" />
      <circle cx="17.5" cy="9" r="2.5" />
      <path d="M17 14.5c2.4.2 4 1.8 4.5 4.5" />
    </>,
  ),
  contacts: svg(
    <>
      <rect x="4" y="3" width="16" height="18" rx="3" />
      <circle cx="12" cy="10" r="2.5" />
      <path d="M7.5 17c.6-2 2.3-3 4.5-3s3.9 1 4.5 3" />
    </>,
  ),
  products: svg(
    <>
      <path d="M4 5h16v14H4z" />
      <path d="M4 10h16M9 5v5" />
    </>,
  ),
  samples: svg(
    <>
      <path d="M2 7h12v9H2zM14 10h4l4 3v3h-8z" />
      <circle cx="6.5" cy="18" r="1.8" />
      <circle cx="17.5" cy="18" r="1.8" />
    </>,
  ),
  review: svg(<path d="M20 6L9 17l-5-5" />),
  import: svg(<path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v3h16v-3" />),
  settings: svg(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" />
    </>,
  ),
};

export function AppShell() {
  return (
    <AiPanelProvider>
      <RecordHost>
        <Shell />
      </RecordHost>
    </AiPanelProvider>
  );
}

function Shell() {
  const { open, setOpen } = useAiPanel();
  const pending = useQuery({
    queryKey: ['review-pending'],
    queryFn: async () => (await (await fetch('/api/review/pending')).json()) as { rows: unknown[] },
  });
  const pendingCount = pending.data?.rows.length ?? 0;

  return (
    <div className="flex min-h-screen">
      <nav
        aria-label="主导航"
        className="sticky top-0 flex h-screen w-58 shrink-0 flex-col gap-1 border-r border-line bg-surface px-4 py-7"
      >
        <div className="flex items-center gap-2.5 px-2.5 pb-6">
          <div className="flex size-9 items-center justify-center rounded-xl bg-ink">
            <svg
              aria-hidden="true"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#c8f560"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M4 14l5-9 4 6 3-4 4 7z" />
            </svg>
          </div>
          <div className="text-base font-extrabold leading-tight tracking-tight">
            达人直播
            <br />
            <span className="text-xs font-medium text-muted">工作台</span>
          </div>
        </div>
        {NAV_ITEMS.map((item) => (
          <Link
            key={item.key}
            to={item.path}
            activeOptions={{ exact: item.path === '/' }}
            className={navBase}
            activeProps={{
              className: `${navBase} bg-ink font-bold text-white [&_svg]:text-lime`,
            }}
            inactiveProps={{ className: `${navBase} text-ink-2 hover:bg-bg` }}
          >
            <span className="flex items-center gap-3">
              {ICONS[item.key]}
              {item.label}
            </span>
            {item.key === 'review' && pendingCount > 0 && (
              <span className="min-w-5.5 rounded-full bg-[#ff6f59] px-1.5 text-center text-xs font-extrabold text-ink">
                {pendingCount}
              </span>
            )}
          </Link>
        ))}
        <div className="mt-auto rounded-2xl bg-bg px-3.5 py-3 text-xs leading-relaxed text-ink-2">
          <b className="text-ink">数据在本机</b>
          <br />
          每天自动备份，可在设置里恢复
        </div>
      </nav>

      <main className="min-w-0 flex-1 px-9 pb-12 pt-8">
        <Outlet />
      </main>

      {open ? (
        <AiSidebar onClose={() => setOpen(false)} />
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed bottom-6 right-6 flex min-h-12 cursor-pointer items-center gap-2 rounded-full border-0 bg-ink px-5 font-bold text-white shadow-[0_18px_40px_rgba(22,21,43,.28)] hover:bg-brand-dark"
        >
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="#c8f560">
            <path d="M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4z" />
          </svg>
          AI 助手
        </button>
      )}
    </div>
  );
}

import { useQuery } from '@tanstack/react-query';
import { Link, Outlet } from '@tanstack/react-router';
import { NAV_ITEMS } from '@workbench/shared';
import { AiPanelProvider, useAiPanel } from './ai/AiPanel.tsx';
import { AiSidebar } from './ai/AiSidebar.tsx';
import { RecordHost } from './ai/RecordHost.tsx';

const navBase = 'flex min-h-11 items-center justify-between rounded-lg px-3 no-underline';

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
        className="flex w-54 shrink-0 flex-col gap-0.5 border-r border-line bg-surface px-4 py-6"
      >
        <div className="px-3 pb-5 pt-1 text-base font-bold">达人直播工作台</div>
        {NAV_ITEMS.map((item) => (
          <Link
            key={item.key}
            to={item.path}
            activeOptions={{ exact: item.path === '/' }}
            className={navBase}
            activeProps={{ className: `${navBase} bg-brand-soft font-medium text-brand` }}
            inactiveProps={{ className: `${navBase} text-ink-2 hover:bg-bg` }}
          >
            {item.label}
            {item.key === 'review' && pendingCount > 0 && (
              <span className="min-w-5.5 rounded-full bg-warn px-1.5 text-center text-xs text-white">
                {pendingCount}
              </span>
            )}
          </Link>
        ))}
      </nav>

      <main className="min-w-0 flex-1 px-8 pb-10 pt-7">
        <Outlet />
      </main>

      {open ? (
        <AiSidebar onClose={() => setOpen(false)} />
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed bottom-6 right-6 min-h-11 cursor-pointer rounded-full bg-brand px-5 text-white shadow-md hover:bg-brand-dark"
        >
          AI 助手
        </button>
      )}
    </div>
  );
}

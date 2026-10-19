import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { api } from '../lib/api.ts';
import { fmtDateTime } from '../lib/format.ts';
import { fieldLabel, fmtValue } from '../lib/labels.ts';
import { Badge, Button, Card, Empty, useToast } from './ui.tsx';

/** 写操作的统一处理：成功后刷新所有查询；被拒绝/冲突时提示。 */
export function useAction() {
  const qc = useQueryClient();
  const toast = useToast();
  return async function run<T>(fn: () => Promise<T>, okMsg?: string): Promise<T | undefined> {
    try {
      const res = await fn();
      await qc.invalidateQueries();
      const r = res as { status?: string; reason?: string } | undefined;
      if (r?.status === 'pending') toast(`已提交审核（${r.reason}），到「审核」页处理`);
      else if (okMsg) toast(okMsg);
      return res;
    } catch (e) {
      toast((e as Error).message, 'error');
      return undefined;
    }
  };
}

export function patchEntity(
  entity: string,
  id: string,
  patch: Record<string, unknown>,
  version: number,
) {
  return api('PATCH', `/e/${entity}/${id}`, { patch, expectedVersion: version });
}

const ACTION: Record<string, string> = { create: '新建', update: '修改', delete: '删除' };

interface Log {
  id: string;
  action: string;
  actorType: string;
  createdAt: string;
  undoOf: string | null;
  revertedAt: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  source?: string | null;
}

const SKIP = new Set(['updatedAt', 'version', 'deletedAt']);

function diffText(l: Log): string {
  if (l.action !== 'update' || !l.before || !l.after) return '';
  return Object.keys(l.after)
    .filter((k) => !SKIP.has(k) && JSON.stringify(l.before![k]) !== JSON.stringify(l.after![k]))
    .map((k) => `${fieldLabel(k)}：${fmtValue(k, l.before![k])} → ${fmtValue(k, l.after![k])}`)
    .join('；');
}

export function HistoryList({ logs }: { logs: Log[] }) {
  const run = useAction();
  if (!logs.length) return <Empty>暂无变更记录</Empty>;
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {logs.map((l) => (
        <li key={l.id} className="rounded-lg border border-line bg-surface px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <span>
              <b>{l.undoOf ? '撤销' : (ACTION[l.action] ?? l.action)}</b>{' '}
              <span className="text-muted">{fmtDateTime(l.createdAt)}</span>{' '}
              <Badge>
                {{ user: '手动', agent: 'AI', import: '导入' }[l.actorType] ?? l.actorType}
              </Badge>
              {l.revertedAt && <Badge tone="orange">已撤销</Badge>}
            </span>
            {!l.revertedAt && !l.undoOf && (
              <Button
                variant="ghost"
                onClick={() => run(() => api('POST', `/changes/${l.id}/undo`), '已撤销')}
              >
                撤销
              </Button>
            )}
          </div>
          {diffText(l) && (
            <div className="mt-1 break-words text-[13px] text-muted">{diffText(l)}</div>
          )}
        </li>
      ))}
    </ul>
  );
}

export function useDetail<T>(key: string, url: string, id: string) {
  return useQuery({ queryKey: [key, id], queryFn: () => api<T>('GET', `${url}/${id}`) });
}

export function Section({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <Card title={title} actions={actions}>
      {children}
    </Card>
  );
}

/** 点击后才请求明文的开关 */
export function useReveal(url: string) {
  const [data, setData] = useState<Record<string, any> | null>(null); // eslint-disable-line @typescript-eslint/no-explicit-any
  const toast = useToast();
  return {
    data,
    toggle: async () => {
      if (data) return setData(null);
      try {
        setData(await api('GET', url));
      } catch (e) {
        toast((e as Error).message, 'error');
      }
    },
  };
}

import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, qs } from '../lib/api.ts';
import { fmtDateTime } from '../lib/format.ts';
import { ACTOR_LABEL, ENTITY_LABEL, fieldLabel, fmtValue } from '../lib/labels.ts';
import { useAction } from './detail.tsx';
import { Badge, Button, Card, ConfirmDialog, Empty, Select, useToast } from './ui.tsx';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const ACTION_LABEL: Record<string, string> = {
  create: '新建',
  update: '修改',
  delete: '删除',
  restore: '恢复',
};
const ENTITIES = [
  'product',
  'influencer',
  'contact',
  'cooperation',
  'cooperation_product',
  'follow_up',
  'sample_shipment',
  'sample_return_item',
  'sample_writeoff',
  'platform_account',
];

/** 变更日志：每次写入都有记录，可按条或按批撤销（PRD 5.6）。 */
export function ChangeLogPanel() {
  const run = useAction();
  const toast = useToast();
  const [entity, setEntity] = useState('');
  const [actor, setActor] = useState('');
  const [confirmBatch, setConfirmBatch] = useState<{ id: string; size: number } | null>(null);
  const q = useInfiniteQuery({
    queryKey: ['changes', entity, actor],
    initialPageParam: '',
    queryFn: ({ pageParam }) =>
      api<{ rows: Row[]; next: string | null }>(
        'GET',
        '/changes' + qs({ entity, actor, before: pageParam, limit: 30 }),
      ),
    getNextPageParam: (last) => last.next ?? undefined,
  });
  const rows = q.data?.pages.flatMap((p) => p.rows) ?? [];

  async function undoBatch(batchId: string) {
    const res = await run(() => api('POST', `/batches/${batchId}/undo`));
    if (res)
      toast(
        `已撤销 ${res.undone.length} 条${res.conflicts.length ? `，${res.conflicts.length} 条因记录之后被改过而跳过` : ''}`,
        res.conflicts.length ? 'error' : 'ok',
      );
  }

  return (
    <Card title="变更日志">
      <div className="mb-3 flex flex-wrap gap-2">
        <Select
          aria-label="对象"
          className="!w-auto"
          value={entity}
          onChange={(e) => setEntity(e.target.value)}
        >
          <option value="">对象：全部</option>
          {ENTITIES.map((e) => (
            <option key={e} value={e}>
              {ENTITY_LABEL[e]}
            </option>
          ))}
        </Select>
        <Select
          aria-label="操作者"
          className="!w-auto"
          value={actor}
          onChange={(e) => setActor(e.target.value)}
        >
          <option value="">操作者：全部</option>
          {Object.entries(ACTOR_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
      </div>
      {q.isPending && <Empty>加载中…</Empty>}
      {q.data && rows.length === 0 && <Empty>没有符合条件的记录</Empty>}
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {rows.map((l) => (
          <li
            key={l.id}
            className={`rounded-2xl bg-bg px-4 py-3 ${l.revertedAt ? 'opacity-60' : ''}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>
                <b>{l.undoOf ? '撤销' : (ACTION_LABEL[l.action] ?? l.action)}</b>{' '}
                <Badge>{ENTITY_LABEL[l.entity] ?? l.entity}</Badge> {l.target}{' '}
                <Badge tone={l.actorType === 'user' ? 'gray' : 'green'}>
                  {ACTOR_LABEL[l.actorType] ?? l.actorType}
                  {l.approvedBy ? ' · 已审核' : ''}
                </Badge>
                {l.batchSize > 1 && <Badge tone="orange">同批 {l.batchSize} 条</Badge>}
                {l.revertedAt && <Badge tone="orange">已撤销</Badge>}
              </span>
              <span className="flex items-center gap-1">
                <span className="text-[13px] text-muted">{fmtDateTime(l.createdAt)}</span>
                {!l.revertedAt && !l.undoOf && (
                  <Button
                    variant="ghost"
                    onClick={() => run(() => api('POST', `/changes/${l.id}/undo`), '已撤销')}
                  >
                    撤销
                  </Button>
                )}
                {l.batchId && l.batchSize > 1 && !l.undoOf && (
                  <Button
                    variant="ghost"
                    onClick={() => setConfirmBatch({ id: l.batchId, size: l.batchSize })}
                  >
                    撤销整批
                  </Button>
                )}
              </span>
            </div>
            {l.source && <div className="text-[13px] text-muted">来源：{l.source}</div>}
            {l.changes.length > 0 && (
              <ul className="m-0 mt-1 list-none p-0 text-[13px] text-muted">
                {l.changes.map((c: Row) => (
                  <li key={c.field}>
                    {fieldLabel(c.field)}：{fmtValue(c.field, c.before)} →{' '}
                    <span className="text-ink">{fmtValue(c.field, c.after)}</span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
      {q.hasNextPage && (
        <div className="mt-3 text-center">
          <Button disabled={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
            加载更多
          </Button>
        </div>
      )}
      {confirmBatch && (
        <ConfirmDialog
          title="撤销整批"
          danger
          confirmLabel="撤销整批"
          message={`撤销这一批的 ${confirmBatch.size} 条改动？之后又被改过的记录会被跳过并提示冲突。`}
          onClose={() => setConfirmBatch(null)}
          onConfirm={() => undoBatch(confirmBatch.id)}
        />
      )}
    </Card>
  );
}

import { useQuery } from '@tanstack/react-query';
import { PageHeader } from '../components/ui.tsx';
import { DiffTable, type FieldDiff } from '../components/Diff.tsx';
import { useAction } from '../components/detail.tsx';
import { Badge, Button, Card, Empty, useToast } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { fmtDateTime } from '../lib/format.ts';
import { ACTOR_LABEL, ENTITY_LABEL } from '../lib/labels.ts';

interface Pending {
  id: string;
  entity: string;
  action: 'update' | 'delete' | 'merge';
  status: string;
  reason: string;
  actorType: string;
  source: string | null;
  batchId: string | null;
  batchSize: number;
  createdAt: string;
  target: string;
  stale: boolean;
  staleReason: string | null;
  diff: FieldDiff[];
  merge: { mergeNickname: string } | null;
}

export function ReviewPage() {
  const q = useQuery({
    queryKey: ['review-pending'],
    queryFn: () => api<{ rows: Pending[] }>('GET', '/review/pending'),
  });
  const rows = q.data?.rows ?? [];

  // 同一批提出的改动放在一起，可以整批通过或驳回；单条的直接显示
  const batches = new Map<string, Pending[]>();
  const singles: Pending[] = [];
  for (const r of rows) {
    if (r.batchId && r.batchSize > 1)
      batches.set(r.batchId, [...(batches.get(r.batchId) ?? []), r]);
    else singles.push(r);
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="审核"
        hint="删除、合并达人、批量修改、改金额或佣金、修改已完成的合作：来自 AI 或导入时先在这里等你确认，待审核的改动不会过期"
      />
      {q.isPending && <Empty>加载中…</Empty>}
      {q.data && rows.length === 0 && <Empty>没有待审核的改动</Empty>}
      {[...batches].map(([batchId, items]) => (
        <BatchGroup key={batchId} batchId={batchId} items={items} />
      ))}
      {singles.map((p) => (
        <PendingCard key={p.id} p={p} />
      ))}
    </div>
  );
}

function BatchGroup({ batchId, items }: { batchId: string; items: Pending[] }) {
  const run = useAction();
  const toast = useToast();
  const first = items[0]!;
  const stale = items.filter((i) => i.stale).length;
  return (
    <section className="rounded-[28px] bg-[#e9e7f7] p-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 px-1">
        <div>
          <b>同一批 {items.length} 条改动</b>{' '}
          <span className="text-muted">
            · {ACTOR_LABEL[first.actorType] ?? first.actorType} · {fmtDateTime(first.createdAt)}
            {first.source ? ` · ${first.source}` : ''}
          </span>
          {stale > 0 && <Badge tone="orange">{stale} 条需要重新确认</Badge>}
        </div>
        <div className="flex gap-2">
          <Button
            variant="primary"
            onClick={async () => {
              const res = await run(() => api('POST', `/review/batch/${batchId}/approve`));
              if (res?.conflicts?.length) {
                toast(
                  `${res.approved.length} 条已通过，${res.conflicts.length} 条因记录已被修改需要重新确认`,
                  'error',
                );
              }
            }}
          >
            整批通过
          </Button>
          <Button
            onClick={() => run(() => api('POST', `/review/batch/${batchId}/reject`), '已整批驳回')}
          >
            整批驳回
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-3">
        {items.map((p) => (
          <PendingCard key={p.id} p={p} />
        ))}
      </div>
    </section>
  );
}

function PendingCard({ p }: { p: Pending }) {
  const run = useAction();
  const summary =
    p.action === 'merge' ? (
      <>
        把「{p.merge?.mergeNickname}」合并到「{p.target}
        」：账号、合作、跟进、样品都会归到保留的达人名下，原档案删除（可撤销）
      </>
    ) : p.action === 'delete' ? (
      <>删除「{p.target}」</>
    ) : (
      <>修改「{p.target}」</>
    );
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="orange">{p.reason}</Badge>
            <Badge>{ENTITY_LABEL[p.entity] ?? p.entity}</Badge>
            {p.stale && <Badge tone="red">需要重新确认</Badge>}
          </div>
          <div className="mt-1.5 font-medium">{summary}</div>
          <div className="text-[13px] text-muted">
            {ACTOR_LABEL[p.actorType] ?? p.actorType}提出 · {fmtDateTime(p.createdAt)}
            {p.source ? ` · 出处：${p.source}` : ''}
          </div>
          <DiffTable diff={p.diff} />
          {p.stale && p.staleReason && (
            <p className="mb-0 mt-2 text-warn" role="alert">
              {p.staleReason}。点「重新确认」按记录现在的状态再看一遍。
            </p>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          {p.stale ? (
            <Button
              variant="primary"
              onClick={() =>
                run(() => api('POST', `/review/${p.id}/rebase`), '已按最新状态重新生成')
              }
            >
              重新确认
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={() => run(() => api('POST', `/review/${p.id}/approve`), '已通过')}
            >
              通过
            </Button>
          )}
          <Button onClick={() => run(() => api('POST', `/review/${p.id}/reject`), '已驳回')}>
            驳回
          </Button>
        </div>
      </div>
    </Card>
  );
}

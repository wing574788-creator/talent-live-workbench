import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../lib/api.ts';
import { fmtDateTime } from '../../lib/format.ts';
import { ENTITY_LABEL } from '../../lib/labels.ts';
import { useAction } from '../detail.tsx';
import { Badge, Button, Card, ConfirmDialog, Empty, Modal } from '../ui.tsx';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const STATUS: Record<string, { label: string; tone: 'green' | 'gray' | 'orange' }> = {
  committed: { label: '已导入', tone: 'green' },
  rolled_back: { label: '已回滚', tone: 'gray' },
  partial: { label: '部分回滚', tone: 'orange' },
  running: { label: '进行中', tone: 'orange' },
};

/** 导入批次：每次导入一个批次，可以整批回滚；导入后又被改过的记录标为冲突，保留现状 */
export function Batches() {
  const run = useAction();
  const q = useQuery({
    queryKey: ['import-batches'],
    queryFn: () => api<{ rows: Row[] }>('GET', '/import/batches'),
  });
  const [confirm, setConfirm] = useState<Row | null>(null);
  const [result, setResult] = useState<Row | null>(null);
  const rows = q.data?.rows ?? [];

  return (
    <div className="flex flex-col gap-3">
      {q.isPending && <Empty>加载中…</Empty>}
      {q.data && rows.length === 0 && (
        <Empty>还没有导入过。导入后的批次会显示在这里，可以整批回滚。</Empty>
      )}
      {rows.map((b) => {
        const sheets: Row[] = b.stats?.sheets ?? [];
        const st = STATUS[b.status] ?? { label: b.status, tone: 'gray' as const };
        return (
          <Card key={b.id}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <b>{b.fileName ?? '（未命名）'}</b> <Badge tone={st.tone}>{st.label}</Badge>
                <div className="text-[13px] text-muted">
                  {fmtDateTime(b.createdAt)}
                  {b.rolledBackAt ? ` · 回滚于 ${fmtDateTime(b.rolledBackAt)}` : ''}
                </div>
                {sheets.map((s) => (
                  <div key={s.sheet} className="mt-1 text-[13px]">
                    {s.sheet}：新增 {s.created}、更新 {s.updated}、跳过 {s.skipped}
                    {s.pendingReview > 0 && `、${s.pendingReview} 条进审核`}
                    {s.failed > 0 && <span className="text-warn">、失败 {s.failed}</span>}
                  </div>
                ))}
                {b.stats?.rollback && (
                  <div className="mt-1 text-[13px] text-muted">
                    回滚：撤销 {b.stats.rollback.undone} 条
                    {b.stats.rollback.rejectedPending > 0 &&
                      `，驳回 ${b.stats.rollback.rejectedPending} 条待审核`}
                    {b.stats.rollback.conflicts > 0 && (
                      <span className="text-warn">
                        ，{b.stats.rollback.conflicts} 条因导入后被改过而保留
                      </span>
                    )}
                  </div>
                )}
              </div>
              {(b.status === 'committed' || b.status === 'partial') && (
                <Button variant="danger" onClick={() => setConfirm(b)}>
                  整批回滚
                </Button>
              )}
            </div>
          </Card>
        );
      })}
      {confirm && (
        <ConfirmDialog
          title="整批回滚"
          danger
          confirmLabel="回滚"
          message={
            <>
              撤销「{confirm.fileName}
              」这一批导入写入的全部数据，并驳回其中还在待审核的改动。导入之后又被你修改过的记录会保留现状，并在结果里列出来。
            </>
          }
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            const res = await run(() => api('POST', `/import/batches/${confirm.id}/rollback`));
            if (res) setResult(res);
          }}
        />
      )}
      {result && (
        <Modal
          title="回滚结果"
          onClose={() => setResult(null)}
          width={480}
          footer={
            <Button variant="primary" onClick={() => setResult(null)}>
              知道了
            </Button>
          }
        >
          <p className="mt-0">
            已撤销 {result.undone} 条改动
            {result.rejectedPending > 0 && `，驳回 ${result.rejectedPending} 条待审核`}。
          </p>
          {result.conflicts.length > 0 ? (
            <>
              <p className="text-warn">
                下面 {result.conflicts.length} 条记录在导入之后又被修改过，已保留现状，没有撤销：
              </p>
              <ul className="m-0 pl-5">
                {result.conflicts.map((c: Row) => (
                  <li key={c.logId}>
                    {ENTITY_LABEL[c.entity] ?? c.entity}：{c.target}
                  </li>
                ))}
              </ul>
              <p className="mb-0 text-[13px] text-muted">
                需要的话可以在对应记录里手动处理，或到设置页的变更日志里逐条撤销。
              </p>
            </>
          ) : (
            <p className="mb-0 text-muted">没有冲突，整批已完整回滚。</p>
          )}
        </Modal>
      )}
    </div>
  );
}

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { SamplesPanel } from '../components/samples.tsx';
import { useAction } from '../components/detail.tsx';
import {
  Avatar,
  Badge,
  Button,
  Drawer,
  Empty,
  Field,
  Modal,
  PageHeader,
  PillTabs,
  TABLE,
  TextInput,
  useToast,
} from '../components/ui.tsx';
import { api, qs } from '../lib/api.ts';
import { fmtDate } from '../lib/format.ts';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const TABS = [
  { key: 'pendingShip', label: '待寄样' },
  { key: 'outstanding', label: '在外' },
  { key: 'overdue', label: '有逾期' },
  { key: 'qa', label: '质检待处理' },
  { key: 'settled', label: '已结清' },
  { key: '', label: '全部' },
] as const;

const today = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

export function SamplesPage() {
  const [tab, setTab] = useState<string>('outstanding');
  const [openInf, setOpenInf] = useState<Row | null>(null);
  const [picking, setPicking] = useState(false);
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="寄样" hint="样品按达人记账：在外 = 累计寄出 − 退回 − 核销，自动计算">
        <Button variant="primary" className="!min-h-11" onClick={() => setPicking(true)}>
          登记退回…
        </Button>
      </PageHeader>
      <PillTabs
        label="寄样筛选"
        tabs={TABS.map((t) => ({ key: t.key as string, label: t.label }))}
        value={tab}
        onChange={setTab}
      />
      {tab === 'pendingShip' ? (
        <PendingShipments onOpen={setOpenInf} />
      ) : (
        <Summary filter={tab} onOpen={setOpenInf} />
      )}
      {picking && (
        <PickInfluencer
          onClose={() => setPicking(false)}
          onPick={(i) => {
            setPicking(false);
            setOpenInf(i);
          }}
        />
      )}
      {openInf && (
        <Drawer
          title={`${openInf.nickname} · 样品台账`}
          width={820}
          onClose={() => setOpenInf(null)}
        >
          <SamplesPanel influencerId={openInf.id} />
        </Drawer>
      )}
    </div>
  );
}

function Summary({ filter, onOpen }: { filter: string; onOpen: (i: Row) => void }) {
  const q = useQuery({
    queryKey: ['samples-summary', filter],
    queryFn: () => api<{ rows: Row[] }>('GET', '/samples' + qs({ filter })),
  });
  const rows = q.data?.rows ?? [];
  return (
    <div className={TABLE.wrap}>
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className={TABLE.headRow}>
            {['达人', '在外', '逾期', '待寄样', '质检待处理', '回收问题'].map((h) => (
              <th key={h} className={TABLE.th}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.influencer.id} className={TABLE.row} onClick={() => onOpen(r.influencer)}>
              <td className={TABLE.td}>
                <span className="flex items-center gap-3">
                  <Avatar name={String(r.influencer.nickname)} />
                  <b className="text-[15px]">{r.influencer.nickname}</b>
                  {r.settled && <Badge tone="green">已结清</Badge>}
                </span>
              </td>
              <td className={TABLE.td}>
                <b className="text-lg">{r.outstanding}</b> <span className="text-muted">件</span>
              </td>
              <td className={TABLE.td}>
                {r.overdueQty ? (
                  <span className="rounded-full bg-warn-soft px-2.5 py-0.5 text-xs font-extrabold text-warn">
                    逾期 {r.overdueQty} 件
                  </span>
                ) : (
                  <span className="text-muted">—</span>
                )}
              </td>
              <td className={TABLE.td}>{r.pendingShip || <span className="text-muted">—</span>}</td>
              <td className={TABLE.td}>
                {r.qaPending ? (
                  <Badge tone="orange">{r.qaPending}</Badge>
                ) : (
                  <span className="text-muted">—</span>
                )}
              </td>
              <td className={TABLE.td}>
                {r.recycleIssueCount || <span className="text-muted">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {q.isPending && <Empty>加载中…</Empty>}
      {q.data && rows.length === 0 && <Empty>没有符合条件的达人</Empty>}
    </div>
  );
}

function PendingShipments({ onOpen }: { onOpen: (i: Row) => void }) {
  const run = useAction();
  const toast = useToast();
  const q = useQuery({
    queryKey: ['samples-pending'],
    queryFn: () => api<{ rows: Row[]; thresholdDays: number }>('GET', '/samples/pending-shipments'),
  });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [at, setAt] = useState(today());
  const rows = q.data?.rows ?? [];
  const days = (iso: string) =>
    Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 86400_000));
  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={rows.length > 0 && picked.size === rows.length}
            onChange={(e) =>
              setPicked(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())
            }
          />
          全选
        </label>
        <div className="w-44">
          <TextInput
            type="date"
            aria-label="寄出日期"
            value={at}
            onChange={(e) => setAt(e.target.value)}
          />
        </div>
        <Button
          variant="primary"
          disabled={!picked.size}
          onClick={async () => {
            const res = await run(() =>
              api('POST', '/samples/shipments/ship', { ids: [...picked], shippedAt: at }),
            );
            if (!res) return;
            setPicked(new Set());
            toast(
              `已寄出 ${res.shipped.length} 张${res.failed.length ? `，${res.failed.length} 张失败：${res.failed[0].error}` : ''}`,
              res.failed.length ? 'error' : 'ok',
            );
          }}
        >
          批量标记寄出（{picked.size}）
        </Button>
        <span className="text-[13px] text-muted">
          使用达人的默认收货地址；没有地址的会失败并提示。
        </span>
      </div>
      <div className="flex flex-col gap-3">
        {rows.map((r) => {
          const waited = days(r.createdAt);
          return (
            <div
              key={r.id}
              className="flex items-start gap-4 rounded-3xl bg-surface p-5 shadow-[0_1px_0_var(--color-line)]"
            >
              <input
                type="checkbox"
                aria-label={`选择 ${r.influencerNickname} 的待寄样单`}
                checked={picked.has(r.id)}
                onChange={() => toggle(r.id)}
                className="mt-2 size-4 cursor-pointer accent-[#4f46e5]"
              />
              <Avatar name={String(r.influencerNickname)} size={40} />
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  className="cursor-pointer border-0 bg-transparent p-0 font-bold text-brand"
                  onClick={() => onOpen({ id: r.influencerId, nickname: r.influencerNickname })}
                >
                  {r.influencerNickname}
                </button>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {r.items.map((i: Row, idx: number) => (
                    <span key={idx} className="rounded-lg bg-bg px-2.5 py-1 text-xs font-medium">
                      {i.styleNo} {i.productName} · {i.color} {i.size} ×{i.qty}
                    </span>
                  ))}
                </div>
              </div>
              <span
                className={
                  waited > (q.data?.thresholdDays ?? 3)
                    ? 'whitespace-nowrap rounded-full bg-warn-soft px-3 py-1 text-xs font-extrabold text-warn'
                    : 'whitespace-nowrap text-xs text-muted'
                }
              >
                {fmtDate(r.createdAt)} 建单
                {waited > (q.data?.thresholdDays ?? 3) ? `，已 ${waited} 天未寄出` : ''}
              </span>
            </div>
          );
        })}
        {q.isPending && <Empty>加载中…</Empty>}
        {q.data && rows.length === 0 && <Empty>没有待寄样的单据</Empty>}
      </div>
    </div>
  );
}

function PickInfluencer({ onClose, onPick }: { onClose: () => void; onPick: (i: Row) => void }) {
  const [q, setQ] = useState('');
  const res = useQuery({
    queryKey: ['pick-inf', q],
    enabled: q.trim().length > 0,
    queryFn: () => api<{ rows: Row[] }>('GET', '/influencers' + qs({ q, limit: 8 })),
  });
  return (
    <Modal
      title="登记退回：选择达人"
      onClose={onClose}
      width={480}
      footer={<Button onClick={onClose}>取消</Button>}
    >
      <Field label="搜索达人">
        <TextInput
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="昵称或账号 ID"
        />
      </Field>
      <div className="mt-2 flex flex-col gap-1">
        {res.data?.rows.map((r) => (
          <button
            key={r.id}
            type="button"
            className="cursor-pointer rounded-lg border border-line bg-surface px-3 py-2 text-left hover:bg-bg"
            onClick={() => onPick(r)}
          >
            {r.nickname}
          </button>
        ))}
      </div>
    </Modal>
  );
}

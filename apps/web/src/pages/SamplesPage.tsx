import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { SamplesPanel } from '../components/samples.tsx';
import { useAction } from '../components/detail.tsx';
import {
  Badge,
  Button,
  Drawer,
  Empty,
  Field,
  Modal,
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="m-0 text-2xl font-bold">寄样</h1>
        <Button variant="primary" onClick={() => setPicking(true)}>
          登记退回…
        </Button>
      </div>
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="寄样筛选">
        {TABS.map((t) => (
          <Button
            key={t.key || 'all'}
            variant={tab === t.key ? 'primary' : 'secondary'}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </Button>
        ))}
      </div>
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
    <div className="overflow-x-auto rounded-xl border border-line bg-surface">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-line bg-bg text-[13px] text-muted">
            {['达人', '在外', '逾期', '待寄样', '质检待处理', '回收问题'].map((h) => (
              <th key={h} className="whitespace-nowrap px-3 py-2.5 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.influencer.id}
              className="cursor-pointer border-b border-line last:border-0 hover:bg-bg"
              onClick={() => onOpen(r.influencer)}
            >
              <td className="px-3 py-2.5">
                <b>{r.influencer.nickname}</b> {r.settled && <Badge tone="green">已结清</Badge>}
              </td>
              <td className="px-3 py-2.5">{r.outstanding} 件</td>
              <td className={`px-3 py-2.5 ${r.overdueQty ? 'font-bold text-warn' : 'text-muted'}`}>
                {r.overdueQty ? `${r.overdueQty} 件` : '—'}
              </td>
              <td className="px-3 py-2.5">{r.pendingShip || '—'}</td>
              <td className={`px-3 py-2.5 ${r.qaPending ? 'text-warn' : 'text-muted'}`}>
                {r.qaPending || '—'}
              </td>
              <td className="px-3 py-2.5">{r.recycleIssueCount || '—'}</td>
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
      <div className="rounded-xl border border-line bg-surface">
        {rows.map((r) => {
          const waited = days(r.createdAt);
          return (
            <div
              key={r.id}
              className="flex items-start gap-3 border-b border-line px-4 py-3 last:border-0"
            >
              <input
                type="checkbox"
                aria-label={`选择 ${r.influencerNickname} 的待寄样单`}
                checked={picked.has(r.id)}
                onChange={() => toggle(r.id)}
                className="mt-1"
              />
              <div className="flex-1">
                <button
                  type="button"
                  className="cursor-pointer border-0 bg-transparent p-0 font-bold text-brand"
                  onClick={() => onOpen({ id: r.influencerId, nickname: r.influencerNickname })}
                >
                  {r.influencerNickname}
                </button>
                <div>
                  {r.items
                    .map((i: Row) => `${i.styleNo} ${i.productName} ${i.color} ${i.size} ×${i.qty}`)
                    .join('；')}
                </div>
              </div>
              <span
                className={
                  waited > (q.data?.thresholdDays ?? 3) ? 'font-bold text-warn' : 'text-muted'
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

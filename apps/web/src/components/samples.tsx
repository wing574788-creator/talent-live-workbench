import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { DISPOSITIONS, QA_RESULTS, WRITEOFF_REASONS } from '@workbench/shared';
import { api, qs, uploadFile } from '../lib/api.ts';
import { fmtDate } from '../lib/format.ts';
import { useSettings } from './FollowUp.tsx';
import { useAction } from './detail.tsx';
import {
  Badge,
  Button,
  Empty,
  Field,
  Modal,
  Select,
  TextInput,
  Textarea,
  ConfirmDialog,
} from './ui.tsx';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const today = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const lineText = (i: Row) => `${i.styleNo} ${i.productName} ${i.color} ${i.size}`;

type Dialog =
  | null
  | { kind: 'new' }
  | { kind: 'ship'; s: Row }
  | { kind: 'return' }
  | { kind: 'writeoff' }
  | { kind: 'extend'; s: Row }
  | { kind: 'clear' };

/** 达人样品台账：在外结余、流水时间线、累计汇总，以及寄出/退回/核销操作。 */
export function SamplesPanel({ influencerId }: { influencerId: string }) {
  const run = useAction();
  const [dlg, setDlg] = useState<Dialog>(null);
  const q = useQuery({
    queryKey: ['samples', influencerId],
    queryFn: () => api<Row>('GET', `/influencers/${influencerId}/samples`),
  });
  if (q.isPending) return <Empty>加载中…</Empty>;
  if (q.isError) return <Empty>{(q.error as Error).message}</Empty>;
  const d = q.data!;
  const sum = d.summary;
  const open = d.totals.filter((t: Row) => t.outstanding > 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => setDlg({ kind: 'new' })}>
          新建待寄样
        </Button>
        <Button disabled={!open.length} onClick={() => setDlg({ kind: 'return' })}>
          登记退回
        </Button>
        <Button disabled={!open.length} onClick={() => setDlg({ kind: 'writeoff' })}>
          核销
        </Button>
        {sum.canClearAddress && (
          <Button onClick={() => setDlg({ kind: 'clear' })}>清除收货地址</Button>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {[
          ['累计寄出', sum.shipped, ''],
          ['累计退回', sum.returned, ''],
          ['核销', sum.writtenOff, ''],
          ['在外', sum.outstanding, ''],
          ['逾期', sum.overdueQty, sum.overdueQty ? 'text-warn' : ''],
          ['质检问题', sum.recycleIssueCount, sum.recycleIssueCount ? 'text-warn' : ''],
        ].map(([label, n, cls]) => (
          <div key={String(label)} className="rounded-2xl bg-bg px-4 py-3">
            <div className="text-[13px] text-muted">{label}</div>
            <div className={`text-xl font-bold ${cls}`}>{n}</div>
          </div>
        ))}
      </div>

      {d.pendingShipments.length > 0 && (
        <Block title={`待寄样（${d.pendingShipments.length}）`}>
          {d.pendingShipments.map((s: Row) => (
            <div
              key={s.id}
              className="flex items-start justify-between gap-2 border-b border-line py-2 last:border-0"
            >
              <span>{s.items.map((i: Row) => `${lineText(i)} ×${i.qty}`).join('；')}</span>
              <span className="flex shrink-0 gap-1">
                <Button variant="primary" onClick={() => setDlg({ kind: 'ship', s })}>
                  寄出
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => run(() => api('DELETE', `/e/sample_shipment/${s.id}`))}
                >
                  删除
                </Button>
              </span>
            </div>
          ))}
        </Block>
      )}

      <Block title="在外结余（按款号 + 颜色 + 尺码）">
        {d.totals.length === 0 ? (
          <Empty>还没有寄出记录</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="text-[13px] text-muted">
                  {[
                    '款号',
                    '款名',
                    '颜色',
                    '尺码',
                    '寄出',
                    '退回',
                    '核销',
                    '在外',
                    '最早应寄回',
                  ].map((h) => (
                    <th key={h} className="whitespace-nowrap px-2 py-1.5 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {d.totals.map((t: Row) => (
                  <tr
                    key={t.key}
                    className={`border-t border-line ${t.outstanding === 0 ? 'text-muted' : ''}`}
                  >
                    <td className="px-2 py-1.5">{t.styleNo}</td>
                    <td className="px-2 py-1.5">{t.productName}</td>
                    <td className="px-2 py-1.5">{t.color}</td>
                    <td className="px-2 py-1.5">{t.size}</td>
                    <td className="px-2 py-1.5">{t.shipped}</td>
                    <td className="px-2 py-1.5">{t.returned}</td>
                    <td className="px-2 py-1.5">{t.writtenOff}</td>
                    <td className="px-2 py-1.5 font-bold">{t.outstanding}</td>
                    <td
                      className={`whitespace-nowrap px-2 py-1.5 ${t.overdue ? 'font-bold text-warn' : ''}`}
                    >
                      {t.outstanding > 0 ? fmtDate(t.dueBackDate) || '—' : ''}
                      {t.overdue && ' 逾期'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Block>

      <Block title="流水">
        {d.timeline.filter((t: Row) => !(t.type === 'ship' && t.status === '待寄样')).length ===
          0 && <Empty>还没有流水</Empty>}
        {d.timeline
          .filter((t: Row) => !(t.type === 'ship' && t.status === '待寄样'))
          .map((t: Row) => (
            <TimelineItem
              key={t.id}
              t={t}
              onSign={() =>
                run(() => api('POST', `/samples/shipments/${t.id}/sign`, {}), '已登记签收')
              }
              onExtend={() => setDlg({ kind: 'extend', s: t })}
            />
          ))}
      </Block>

      {dlg?.kind === 'new' && (
        <NewShipmentDialog influencerId={influencerId} onClose={() => setDlg(null)} />
      )}
      {dlg?.kind === 'ship' && (
        <ShipDialog influencerId={influencerId} s={dlg.s} onClose={() => setDlg(null)} />
      )}
      {dlg?.kind === 'return' && (
        <ReturnDialog influencerId={influencerId} open={open} onClose={() => setDlg(null)} />
      )}
      {dlg?.kind === 'writeoff' && (
        <WriteoffDialog influencerId={influencerId} open={open} onClose={() => setDlg(null)} />
      )}
      {dlg?.kind === 'extend' && <ExtendDialog s={dlg.s} onClose={() => setDlg(null)} />}
      {dlg?.kind === 'clear' && (
        <ConfirmDialog
          title="清除收货地址"
          danger
          confirmLabel="清除"
          message="该达人的样品已全部结清，确定清除他的所有收货地址？可在变更历史里撤销。"
          onClose={() => setDlg(null)}
          onConfirm={() =>
            run(() => api('POST', `/influencers/${influencerId}/clear-addresses`), '收货地址已清除')
          }
        />
      )}
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-3xl bg-surface px-5 py-4 shadow-[0_1px_0_var(--color-line)]">
      <h3 className="mb-2 mt-0 text-[15px] font-bold">{title}</h3>
      {children}
    </section>
  );
}

function TimelineItem({
  t,
  onSign,
  onExtend,
}: {
  t: Row;
  onSign: () => void;
  onExtend: () => void;
}) {
  if (t.type === 'writeoff') {
    return (
      <div className="border-b border-line py-2 last:border-0">
        <span className="text-muted">{fmtDate(t.at)}</span> <Badge tone="orange">核销</Badge>{' '}
        {t.styleNo} {t.color} {t.size} ×{t.qty} · {t.reason}
        {t.note && <span className="text-muted"> · {t.note}</span>}
      </div>
    );
  }
  if (t.type === 'return') {
    return (
      <div className="border-b border-line py-2 last:border-0">
        <div>
          <span className="text-muted">{fmtDate(t.at)}</span> <Badge tone="green">退回</Badge>{' '}
          <span className="text-muted">
            {t.carrier ?? ''} {t.trackingNo ?? ''}
          </span>
        </div>
        {t.items.map((i: Row) => (
          <ReturnItem key={i.id} i={i} />
        ))}
      </div>
    );
  }
  return (
    <div className="border-b border-line py-2 last:border-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          <span className="text-muted">{fmtDate(t.at)}</span> <Badge>{t.status}</Badge>{' '}
          <span className="text-muted">
            {t.carrier ?? ''} {t.trackingNo ?? ''}
          </span>
        </span>
        <span className="flex gap-1">
          {t.status === '已寄出' && (
            <Button variant="ghost" onClick={onSign}>
              登记签收
            </Button>
          )}
          <Button variant="ghost" onClick={onExtend}>
            延期
          </Button>
        </span>
      </div>
      <div>{t.items.map((i: Row) => `${lineText(i)} ×${i.qty}`).join('；')}</div>
      <div className="text-[13px] text-muted">
        {t.signedAt && `签收 ${fmtDate(t.signedAt)} · `}应寄回{' '}
        {t.dueBackDate ? fmtDate(t.dueBackDate) : '待定'}
        {t.address && ` · ${t.recipient ?? ''} ${t.phone ?? ''} ${t.address}`}
      </div>
    </div>
  );
}

/** 退样明细：质检结果、处理结果、照片都可以事后补填；有问题的会计入回收问题次数 */
function ReturnItem({ i }: { i: Row }) {
  const run = useAction();
  const patch = (p: Record<string, unknown>) =>
    run(() =>
      api('PATCH', `/samples/return-items/${i.id}`, { patch: p, expectedVersion: i.version }),
    );
  const photos: string[] = i.photoAttachmentIds ?? [];
  const issue = i.qaResult && i.qaResult !== '完好';
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 rounded-xl bg-bg px-2 py-1.5">
      <span>
        {lineText(i)} ×{i.qty}
      </span>
      <Select
        aria-label="质检结果"
        className="!w-28"
        value={i.qaResult ?? ''}
        onChange={(e) => patch({ qaResult: e.target.value || null })}
      >
        <option value="">待质检</option>
        {QA_RESULTS.map((r) => (
          <option key={r}>{r}</option>
        ))}
      </Select>
      {issue && (
        <Select
          aria-label="处理结果"
          className="!w-28"
          value={i.disposition ?? ''}
          onChange={(e) => patch({ disposition: e.target.value || null })}
        >
          <option value="">待处理</option>
          {DISPOSITIONS.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </Select>
      )}
      {photos.map((id) => (
        <a key={id} href={`/api/attachments/${id}/file`} target="_blank" rel="noreferrer">
          <img
            src={`/api/attachments/${id}/file`}
            alt="质检照片"
            className="h-9 w-9 rounded object-cover"
          />
        </a>
      ))}
      <label className="cursor-pointer text-[13px] text-brand">
        上传照片
        <input
          type="file"
          accept="image/*"
          className="hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            const up = await run(() => uploadFile('/attachments/image', f));
            if (up) await patch({ photoAttachmentIds: [...photos, up.id] });
          }}
        />
      </label>
    </div>
  );
}

// ───────────── 对话框 ─────────────
function NewShipmentDialog({
  influencerId,
  onClose,
}: {
  influencerId: string;
  onClose: () => void;
}) {
  const run = useAction();
  const inf = useQuery({
    queryKey: ['influencer', influencerId],
    queryFn: () => api<Row>('GET', `/influencers/${influencerId}`),
  });
  const [coopId, setCoopId] = useState('');
  const [pq, setPq] = useState('');
  const [prod, setProd] = useState<Row | null>(null);
  const [color, setColor] = useState('');
  const [size, setSize] = useState('');
  const [qty, setQty] = useState('1');
  const [lines, setLines] = useState<Row[]>([]);
  const [err, setErr] = useState('');
  const found = useQuery({
    queryKey: ['smp-prod', pq],
    enabled: !prod && pq.trim().length > 0,
    queryFn: () => api<{ rows: Row[] }>('GET', '/products' + qs({ q: pq, limit: 6 })),
  });
  const detail = useQuery({
    queryKey: ['product', prod?.id],
    enabled: !!prod,
    queryFn: () => api<Row>('GET', `/products/${prod!.id}`),
  });
  const variants: Row[] = detail.data?.variants ?? [];
  const colors = [...new Set(variants.map((v) => v.color))];
  const sizes = variants.filter((v) => v.color === color).map((v) => v.size);

  function addLine() {
    const n = Number(qty);
    if (!prod || !color || !size || !Number.isInteger(n) || n <= 0)
      return setErr('请选择商品、颜色、尺码，数量为正整数');
    setErr('');
    setLines([
      ...lines,
      { productId: prod.id, styleNo: prod.styleNo, productName: prod.name, color, size, qty: n },
    ]);
    setProd(null);
    setPq('');
    setColor('');
    setSize('');
    setQty('1');
  }

  return (
    <Modal
      title="新建待寄样单"
      onClose={onClose}
      width={640}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            onClick={async () => {
              if (!lines.length) return setErr('请至少添加一个款色码');
              const res = await run(
                () =>
                  api('POST', '/samples/shipments', {
                    influencerId,
                    cooperationId: coopId || null,
                    items: lines.map(({ productId, color, size, qty }) => ({
                      productId,
                      color,
                      size,
                      qty,
                    })),
                  }),
                '待寄样单已创建',
              );
              if (res) onClose();
            }}
          >
            创建
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="m-0 text-muted">
          此时还没发货，只记下“要给谁寄什么”。关联合作后，合作会自动进入「待寄样」。
        </p>
        <Field label="关联合作（可选）">
          <Select value={coopId} onChange={(e) => setCoopId(e.target.value)}>
            <option value="">不关联</option>
            {inf.data?.cooperations.map((c: Row) => (
              <option key={c.id} value={c.id}>
                {c.stage}
                {c.liveDate ? ` · 开播 ${fmtDate(c.liveDate)}` : ''}
              </option>
            ))}
          </Select>
        </Field>
        {lines.map((l, i) => (
          <div key={i} className="flex items-center justify-between rounded-xl bg-bg px-3 py-1.5">
            <span>
              {lineText(l)} ×{l.qty}
            </span>
            <Button variant="ghost" onClick={() => setLines(lines.filter((_, j) => j !== i))}>
              移除
            </Button>
          </div>
        ))}
        {!prod ? (
          <>
            <Field label="添加商品">
              <TextInput
                placeholder="搜索款号或名称"
                value={pq}
                onChange={(e) => setPq(e.target.value)}
              />
            </Field>
            {found.data?.rows.map((p) => (
              <button
                key={p.id}
                type="button"
                className="cursor-pointer rounded-2xl bg-bg px-4 py-3 text-left hover:bg-bg"
                onClick={() => setProd(p)}
              >
                {p.styleNo} {p.name}
              </button>
            ))}
          </>
        ) : (
          <div className="grid grid-cols-[1fr_1fr_90px_auto] items-end gap-2">
            <Field label={`${prod.styleNo} ${prod.name} · 颜色`}>
              <Select
                value={color}
                onChange={(e) => {
                  setColor(e.target.value);
                  setSize('');
                }}
              >
                <option value="">选择</option>
                {colors.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </Select>
            </Field>
            <Field label="尺码">
              <Select value={size} onChange={(e) => setSize(e.target.value)}>
                <option value="">选择</option>
                {sizes.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </Select>
            </Field>
            <Field label="数量">
              <TextInput inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} />
            </Field>
            <Button onClick={addLine}>加入</Button>
          </div>
        )}
        {prod && variants.length === 0 && (
          <p className="m-0 text-warn">这个商品还没有色码规格，请先到商品详情里添加。</p>
        )}
        {err && (
          <p className="m-0 text-warn" role="alert">
            {err}
          </p>
        )}
      </div>
    </Modal>
  );
}

function ShipDialog({
  influencerId,
  s,
  onClose,
}: {
  influencerId: string;
  s: Row;
  onClose: () => void;
}) {
  const run = useAction();
  const settings = useSettings();
  const addr = useQuery({
    queryKey: ['reveal', influencerId],
    queryFn: () => api<Row>('GET', `/influencers/${influencerId}/reveal`),
  });
  const def =
    (addr.data?.addresses ?? []).find((a: Row) => a.isDefault) ?? addr.data?.addresses?.[0];
  const [f, setF] = useState({
    shippedAt: today(),
    carrier: '',
    trackingNo: '',
    dueBackDate: '',
    recipient: '',
    phone: '',
    address: '',
  });
  const set = (k: keyof typeof f, v: string) => setF({ ...f, [k]: v });
  return (
    <Modal
      title="寄出"
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            onClick={async () => {
              const res = await run(
                () =>
                  api('POST', `/samples/shipments/${s.id}/ship`, {
                    shippedAt: f.shippedAt || null,
                    carrier: f.carrier || null,
                    trackingNo: f.trackingNo || null,
                    dueBackDate: f.dueBackDate || null,
                    recipient: f.recipient || null,
                    phone: f.phone || null,
                    address: f.address || null,
                  }),
                '已标记寄出，样衣计入在外',
              );
              if (res) onClose();
            }}
          >
            确认寄出
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2 text-muted">
          {s.items.map((i: Row) => `${lineText(i)} ×${i.qty}`).join('；')}
        </div>
        <Field label="寄出日期">
          <TextInput
            type="date"
            value={f.shippedAt}
            onChange={(e) => set('shippedAt', e.target.value)}
          />
        </Field>
        <Field
          label="应寄回日期"
          hint={`留空自动计算：有开播日 = 开播日 + ${settings.data?.returnAfterLiveDays ?? 3} 天；否则 = 签收日 + ${settings.data?.returnAfterSignDays ?? 7} 天（可在设置里修改）`}
        >
          <TextInput
            type="date"
            value={f.dueBackDate}
            onChange={(e) => set('dueBackDate', e.target.value)}
          />
        </Field>
        <Field label="快递公司">
          <TextInput value={f.carrier} onChange={(e) => set('carrier', e.target.value)} />
        </Field>
        <Field label="快递单号">
          <TextInput value={f.trackingNo} onChange={(e) => set('trackingNo', e.target.value)} />
        </Field>
        <div className="col-span-2 rounded-xl bg-bg px-3 py-2">
          <div className="text-[13px] text-muted">收货地址（留空则使用默认地址）</div>
          <div>
            {def
              ? `${def.recipient} ${def.phone ?? ''} ${def.address}`
              : addr.isPending
                ? '加载中…'
                : '该达人还没有收货地址，请在下面填写'}
          </div>
        </div>
        <Field label="收件人">
          <TextInput value={f.recipient} onChange={(e) => set('recipient', e.target.value)} />
        </Field>
        <Field label="手机">
          <TextInput value={f.phone} onChange={(e) => set('phone', e.target.value)} />
        </Field>
        <div className="col-span-2">
          <Field label="地址">
            <Textarea rows={2} value={f.address} onChange={(e) => set('address', e.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

interface RetRow {
  qty: string;
  qa: string;
  disp: string;
  photos: string[];
}

function ReturnDialog({
  influencerId,
  open,
  onClose,
}: {
  influencerId: string;
  open: Row[];
  onClose: () => void;
}) {
  const run = useAction();
  const [rows, setRows] = useState<Record<string, RetRow>>({});
  const [f, setF] = useState({ returnedAt: today(), carrier: '', trackingNo: '' });
  const [err, setErr] = useState('');
  const get = (k: string): RetRow => rows[k] ?? { qty: '', qa: '', disp: '', photos: [] };
  const set = (k: string, p: Partial<RetRow>) => setRows({ ...rows, [k]: { ...get(k), ...p } });

  async function submit() {
    const items: Row[] = [];
    for (const t of open) {
      const r = get(t.key);
      const n = Number(r.qty);
      if (!r.qty) continue;
      if (!Number.isInteger(n) || n <= 0 || n > t.outstanding)
        return setErr(`${lineText(t)} 的退回数量应为 1–${t.outstanding}`);
      items.push({
        styleNo: t.styleNo,
        color: t.color,
        size: t.size,
        qty: n,
        qaResult: r.qa || null,
        disposition: r.disp || null,
        photoAttachmentIds: r.photos,
      });
    }
    if (!items.length) return setErr('请填写本次收到的款色码和数量');
    setErr('');
    const res = await run(
      () =>
        api('POST', '/samples/returns', {
          influencerId,
          returnedAt: f.returnedAt,
          carrier: f.carrier || null,
          trackingNo: f.trackingNo || null,
          items,
        }),
      '退回已登记',
    );
    if (res) onClose();
  }

  return (
    <Modal
      title="登记退回"
      onClose={onClose}
      width={860}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={submit}>
            登记
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="m-0 text-muted">
          系统按款号、颜色、尺码，从最早寄出的记录开始冲抵；一个包裹里有多场合作的样衣，一次登记完。
        </p>
        <div className="grid grid-cols-3 gap-3">
          <Field label="退回日期">
            <TextInput
              type="date"
              value={f.returnedAt}
              onChange={(e) => setF({ ...f, returnedAt: e.target.value })}
            />
          </Field>
          <Field label="快递公司">
            <TextInput
              value={f.carrier}
              onChange={(e) => setF({ ...f, carrier: e.target.value })}
            />
          </Field>
          <Field label="快递单号">
            <TextInput
              value={f.trackingNo}
              onChange={(e) => setF({ ...f, trackingNo: e.target.value })}
            />
          </Field>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="text-[13px] text-muted">
                {['款号 款名', '颜色', '尺码', '在外', '本次退回', '质检', '处理结果', '照片'].map(
                  (h) => (
                    <th key={h} className="px-1.5 py-1 font-medium">
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {open.map((t) => {
                const r = get(t.key);
                const issue = r.qa && r.qa !== '完好';
                return (
                  <tr key={t.key} className="border-t border-line">
                    <td className="px-1.5 py-1.5">
                      {t.styleNo} {t.productName}
                    </td>
                    <td className="px-1.5">{t.color}</td>
                    <td className="px-1.5">{t.size}</td>
                    <td className="px-1.5">{t.outstanding}</td>
                    <td className="px-1.5">
                      <TextInput
                        aria-label={`${lineText(t)} 退回数量`}
                        className="!w-20"
                        inputMode="numeric"
                        value={r.qty}
                        onChange={(e) => set(t.key, { qty: e.target.value })}
                      />
                    </td>
                    <td className="px-1.5">
                      <Select
                        aria-label="质检结果"
                        className="!w-28"
                        value={r.qa}
                        onChange={(e) => set(t.key, { qa: e.target.value })}
                      >
                        <option value="">待质检</option>
                        {QA_RESULTS.map((x) => (
                          <option key={x}>{x}</option>
                        ))}
                      </Select>
                    </td>
                    <td className="px-1.5">
                      {issue ? (
                        <Select
                          aria-label="处理结果"
                          className="!w-28"
                          value={r.disp}
                          onChange={(e) => set(t.key, { disp: e.target.value })}
                        >
                          <option value="">待处理</option>
                          {DISPOSITIONS.map((x) => (
                            <option key={x}>{x}</option>
                          ))}
                        </Select>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="px-1.5">
                      <label className="cursor-pointer text-[13px] text-brand">
                        {r.photos.length ? `已传 ${r.photos.length} 张` : '上传'}
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={async (e) => {
                            const file = e.target.files?.[0];
                            e.target.value = '';
                            if (!file) return;
                            const up = await run(() => uploadFile('/attachments/image', file));
                            if (up) set(t.key, { photos: [...r.photos, up.id] });
                          }}
                        />
                      </label>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {err && (
          <p className="m-0 text-warn" role="alert">
            {err}
          </p>
        )}
      </div>
    </Modal>
  );
}

function WriteoffDialog({
  influencerId,
  open,
  onClose,
}: {
  influencerId: string;
  open: Row[];
  onClose: () => void;
}) {
  const run = useAction();
  const [key, setKey] = useState(open[0]?.key ?? '');
  const [qty, setQty] = useState('1');
  const [reason, setReason] = useState<string>(WRITEOFF_REASONS[0]);
  const [note, setNote] = useState('');
  const [at, setAt] = useState(today());
  const [err, setErr] = useState('');
  const t = open.find((x) => x.key === key);
  return (
    <Modal
      title="核销（不再追回）"
      onClose={onClose}
      width={520}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            onClick={async () => {
              const n = Number(qty);
              if (!t) return setErr('请选择款色码');
              if (!Number.isInteger(n) || n <= 0 || n > t.outstanding)
                return setErr(`数量应为 1–${t.outstanding}`);
              setErr('');
              const res = await run(
                () =>
                  api('POST', '/samples/writeoffs', {
                    influencerId,
                    styleNo: t.styleNo,
                    color: t.color,
                    size: t.size,
                    qty: n,
                    reason,
                    note: note.trim() || null,
                    occurredAt: at,
                  }),
                '已核销',
              );
              if (res) onClose();
            }}
          >
            核销
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="款色码">
          <Select value={key} onChange={(e) => setKey(e.target.value)}>
            {open.map((x) => (
              <option key={x.key} value={x.key}>
                {lineText(x)}（在外 {x.outstanding}）
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="数量">
            <TextInput inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} />
          </Field>
          <Field label="原因">
            <Select value={reason} onChange={(e) => setReason(e.target.value)}>
              {WRITEOFF_REASONS.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </Select>
          </Field>
          <Field label="日期">
            <TextInput type="date" value={at} onChange={(e) => setAt(e.target.value)} />
          </Field>
        </div>
        <Field label="说明">
          <TextInput
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="如：达人买断，已转账"
          />
        </Field>
        {err && (
          <p className="m-0 text-warn" role="alert">
            {err}
          </p>
        )}
      </div>
    </Modal>
  );
}

function ExtendDialog({ s, onClose }: { s: Row; onClose: () => void }) {
  const run = useAction();
  const [due, setDue] = useState(s.dueBackDate ?? '');
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  return (
    <Modal
      title="延后应寄回日期"
      onClose={onClose}
      width={480}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            onClick={async () => {
              if (!due) return setErr('请填写新的应寄回日期');
              if (!note.trim()) return setErr('请填写延期说明');
              setErr('');
              const res = await run(
                () =>
                  api('POST', `/samples/shipments/${s.id}/extend-due`, { dueBackDate: due, note }),
                '已延期',
              );
              if (res) onClose();
            }}
          >
            确认
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="m-0 text-muted">
          上一场的样衣留给下一场用时，不退回也不重新寄出，只延后应寄回日期并记一条说明。
        </p>
        <Field label="新的应寄回日期">
          <TextInput type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        </Field>
        <Field label="说明 *">
          <Textarea
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="如：下一场 10 月 28 日直播还要用"
          />
        </Field>
        {err && (
          <p className="m-0 text-warn" role="alert">
            {err}
          </p>
        )}
      </div>
    </Modal>
  );
}

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, qs } from '../lib/api.ts';
import { yuanToCents } from '../lib/format.ts';
import { useAction } from './detail.tsx';
import { Button, Empty, Modal, TABLE, TextInput, useToast } from './ui.tsx';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

interface Draft {
  pct: string;
  price: string;
  mech: string;
}

const draftOf = (it: Row): Draft => ({
  pct: it.commissionPct == null ? '' : String(it.commissionPct),
  price: it.livePriceCents == null ? '' : String(it.livePriceCents / 100),
  mech: it.mechanism ?? '',
});

/**
 * 合作商品整表编辑：佣金、直播价、机制按商品分别设置，"统一佣金"一键填满，整表一次保存。
 * 佣金只设在合作商品上（PRD 4.4）。用户手动保存直接生效、可在变更历史撤销；
 * AI 或导入提出的佣金改动仍进审核（服务端规则，不在这里）。
 */
export function CommissionTable({
  coopId,
  items,
  onSaved,
}: {
  coopId: string;
  items: Row[];
  onSaved?: () => void;
}) {
  const run = useAction();
  const qc = useQueryClient();
  const toast = useToast();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [all, setAll] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [pq, setPq] = useState('');
  const prods = useQuery({
    queryKey: ['coop-prod-search', pq],
    enabled: pq.trim().length > 0,
    queryFn: () => api<{ rows: Row[] }>('GET', '/products' + qs({ q: pq, limit: 6 })),
  });

  // 服务端数据变了（保存、撤销）就丢掉对应行的草稿
  useEffect(() => setDrafts({}), [items]);

  const get = (it: Row) => drafts[it.id] ?? draftOf(it);
  const set = (it: Row, patch: Partial<Draft>) =>
    setDrafts({ ...drafts, [it.id]: { ...get(it), ...patch } });
  const dirty = items.filter((it) => {
    const d = drafts[it.id];
    if (!d) return false;
    const o = draftOf(it);
    return d.pct !== o.pct || d.price !== o.price || d.mech !== o.mech;
  });

  async function save() {
    const patches: { it: Row; patch: Record<string, unknown> }[] = [];
    for (const it of dirty) {
      const d = drafts[it.id]!;
      const p = d.pct.trim() === '' ? null : Number(d.pct);
      if (p !== null && (!Number.isFinite(p) || p < 0 || p > 100))
        return setErr(`「${it.product?.name ?? '商品'}」的佣金应为 0–100`);
      const cents = yuanToCents(d.price);
      if (Number.isNaN(cents))
        return setErr(`「${it.product?.name ?? '商品'}」的直播价不是有效金额`);
      patches.push({
        it,
        patch: { commissionPct: p, livePriceCents: cents, mechanism: d.mech.trim() || null },
      });
    }
    setErr('');
    setBusy(true);
    let ok = 0;
    let pending = 0;
    try {
      for (const { it, patch } of patches) {
        const r = await api<{ status?: string }>('PATCH', `/e/cooperation_product/${it.id}`, {
          patch,
          expectedVersion: it.version,
        });
        if (r?.status === 'pending') pending++;
        else ok++;
      }
      toast(
        pending ? `已保存 ${ok} 款，${pending} 款进了审核` : `已保存 ${ok} 款，可在变更历史撤销`,
      );
      onSaved?.();
    } catch (e) {
      toast(`保存中断：${(e as Error).message}（已保存 ${ok} 款）`, 'error');
    } finally {
      setBusy(false);
      await qc.invalidateQueries();
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {items.length === 0 ? (
        <Empty>还没有商品，在下面搜索款号或名称添加</Empty>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted">统一佣金</span>
            <TextInput
              className="!w-24"
              inputMode="decimal"
              aria-label="统一佣金（%）"
              placeholder="%"
              value={all}
              onChange={(e) => setAll(e.target.value)}
            />
            <Button
              disabled={all.trim() === ''}
              onClick={() => {
                const next = { ...drafts };
                for (const it of items) next[it.id] = { ...get(it), pct: all.trim() };
                setDrafts(next);
              }}
            >
              填到全部商品
            </Button>
          </div>
          <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
            <table className="w-full min-w-[560px] border-collapse text-left text-sm">
              <thead>
                <tr className={TABLE.headRow}>
                  {['商品', '佣金 %', '直播价（元）', '机制', ''].map((h) => (
                    <th key={h} className={TABLE.th}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((it) => {
                  const d = get(it);
                  const name = it.product
                    ? `${it.product.styleNo} ${it.product.name}`
                    : '（商品已删除）';
                  return (
                    <tr key={it.id} className="border-b border-line last:border-0">
                      <td className="px-4 py-2.5 font-bold">{name}</td>
                      <td className="px-2 py-2">
                        <TextInput
                          className={`!w-20 ${d.pct === '' ? '!border-amber-300' : ''}`}
                          inputMode="decimal"
                          aria-label={`${name} 佣金（%）`}
                          placeholder="未定"
                          value={d.pct}
                          onChange={(e) => set(it, { pct: e.target.value })}
                        />
                      </td>
                      <td className="px-2 py-2">
                        <TextInput
                          className="!w-28"
                          inputMode="decimal"
                          aria-label={`${name} 直播价（元）`}
                          value={d.price}
                          onChange={(e) => set(it, { price: e.target.value })}
                        />
                      </td>
                      <td className="px-2 py-2">
                        <TextInput
                          aria-label={`${name} 机制`}
                          placeholder="如买一送一"
                          value={d.mech}
                          onChange={(e) => set(it, { mech: e.target.value })}
                        />
                      </td>
                      <td className="px-2 py-2 text-right">
                        <Button
                          variant="ghost"
                          onClick={() =>
                            run(() => api('DELETE', `/e/cooperation_product/${it.id}`), '已移除')
                          }
                        >
                          移除
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" disabled={!dirty.length || busy} onClick={save}>
              {busy ? '保存中…' : dirty.length ? `保存 ${dirty.length} 处改动` : '保存'}
            </Button>
            {dirty.length > 0 && (
              <Button variant="ghost" onClick={() => setDrafts({})}>
                放弃改动
              </Button>
            )}
            <span className="text-[13px] text-muted">保存后直接生效，可在变更历史撤销</span>
          </div>
          {err && (
            <p className="m-0 text-warn" role="alert">
              {err}
            </p>
          )}
        </>
      )}
      <div>
        <TextInput
          placeholder="搜索款号或名称添加商品"
          aria-label="添加商品"
          value={pq}
          onChange={(e) => setPq(e.target.value)}
        />
        {prods.data?.rows
          .filter((p) => !items.some((i) => i.productId === p.id))
          .map((p) => (
            <div key={p.id} className="flex items-center justify-between py-1.5">
              <span>
                {p.styleNo} {p.name}
              </span>
              <Button
                onClick={async () => {
                  if (
                    await run(
                      () =>
                        api('POST', '/e/cooperation_product', {
                          cooperationId: coopId,
                          productId: p.id,
                        }),
                      '已添加',
                    )
                  )
                    setPq('');
                }}
              >
                添加
              </Button>
            </div>
          ))}
      </div>
    </div>
  );
}

/** 改成"已确认"之后弹出：把佣金定下来（可以跳过，之后在合作商品里再填） */
export function CommissionDialog({ coopId, onClose }: { coopId: string; onClose: () => void }) {
  const q = useQuery({
    queryKey: ['cooperation', coopId],
    queryFn: () => api<Row>('GET', `/cooperations/${coopId}`),
  });
  return (
    <Modal
      title={`已确认 · 定一下佣金${q.data ? `（${q.data.influencer?.nickname ?? ''}）` : ''}`}
      onClose={onClose}
      width={760}
      footer={<Button onClick={onClose}>跳过，之后再填</Button>}
    >
      {q.data ? (
        <CommissionTable coopId={coopId} items={q.data.products} onSaved={onClose} />
      ) : (
        <Empty>加载中…</Empty>
      )}
    </Modal>
  );
}

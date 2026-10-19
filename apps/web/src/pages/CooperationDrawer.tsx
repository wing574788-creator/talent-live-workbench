import { useQuery } from '@tanstack/react-query';
import { useRegisterSelection } from '../lib/selection.ts';
import { useState } from 'react';
import { COOP_MODES, COOP_STAGES, PAYMENT_STATUSES } from '@workbench/shared';
import { EditableFields, type FieldSpec } from '../components/FormFields.tsx';
import { FollowTimeline, FollowUpDialog, useSettings } from '../components/FollowUp.tsx';
import { HistoryList, Section, patchEntity, useAction, useDetail } from '../components/detail.tsx';
import {
  Badge,
  Button,
  ConfirmDialog,
  Drawer,
  Empty,
  Select,
  Tabs,
  TextInput,
} from '../components/ui.tsx';
import { api, qs } from '../lib/api.ts';
import { fmtDate, fmtMoney, yuanToCents } from '../lib/format.ts';
import { useStageChange } from '../components/useStageChange.tsx';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function CooperationDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  useRegisterSelection('cooperation', id);
  const run = useAction();
  const q = useDetail<Row>('cooperation', '/cooperations', id);
  const settings = useSettings();
  const customDefs = useQuery({
    queryKey: ['field_defs', 'cooperation'],
    queryFn: () => api<{ rows: Row[] }>('GET', '/e/field_def?f.entity=cooperation'),
  });
  const { request, dialog } = useStageChange();
  const [tab, setTab] = useState('基本信息');
  const [follow, setFollow] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const d = q.data;
  const c = d?.cooperation;

  const specs: FieldSpec[] = c
    ? [
        { key: 'stage', label: '阶段', type: 'select', options: [...COOP_STAGES], required: true },
        {
          key: 'followStatus',
          label: '跟进状态',
          type: 'select',
          options: settings.data?.followStatuses.map((s) => s.value) ?? [],
        },
        { key: 'nextFollowDate', label: '下次跟进日期', type: 'date' },
        { key: 'mode', label: '合作模式', type: 'select', options: [...COOP_MODES] },
        ...(c.mode !== '纯佣'
          ? ([
              {
                key: 'paymentStatus',
                label: '付款状态',
                type: 'select',
                options: [...PAYMENT_STATUSES],
              },
              { key: 'slotFeeCents', label: '坑位费', type: 'money' },
            ] as FieldSpec[])
          : []),
        { key: 'liveDate', label: '开播日期', type: 'date' },
        { key: 'liveSlot', label: '开播时段', type: 'text', placeholder: '如 20:00-23:00' },
        { key: 'linkMethod', label: '挂链方式', type: 'text' },
        ...(c.stage === '流失' || c.stage === '放弃' || c.lostReason
          ? ([
              { key: 'lostReason', label: '流失/放弃原因', type: 'text', wide: true },
            ] as FieldSpec[])
          : []),
        { key: 'channel', label: '合作通道', type: 'text' },
        { key: 'reportStatus', label: '报备状态', type: 'text' },
        ...(customDefs.data?.rows ?? []).map<FieldSpec>((f) => ({
          key: f.key,
          label: f.label,
          custom: true,
          type: f.type === 'multiselect' ? 'tags' : f.type,
          options: f.options ?? undefined,
        })),
      ]
    : [];

  return (
    <Drawer
      title={
        c && d ? `${d.influencer?.nickname ?? '（已删除）'} · ${d.account?.platform ?? ''}` : '合作'
      }
      onClose={onClose}
      width={720}
    >
      {q.isPending && <Empty>加载中…</Empty>}
      {q.isError && <Empty>{(q.error as Error).message}</Empty>}
      {d && c && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Select
              aria-label="阶段"
              className="!w-32"
              value={c.stage}
              onChange={(e) => request(c, e.target.value)}
            >
              {COOP_STAGES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </Select>
            <span className="text-muted">
              {d.stats.followCount === 0
                ? '还没有跟进'
                : `第 ${d.stats.followCount} 次跟进 · ${c.followStatus ?? '无状态'} · ${d.stats.daysSinceFollow === 0 ? '今天' : `${d.stats.daysSinceFollow} 天前`}`}
            </span>
            {c.nextFollowDate && <Badge tone="green">下次跟进 {fmtDate(c.nextFollowDate)}</Badge>}
            <span className="ml-auto">
              <Button variant="primary" onClick={() => setFollow(true)}>
                记一笔跟进
              </Button>
            </span>
          </div>

          {d.stats.stalled && c.stage === '洽谈中' && (
            <div
              className="flex flex-wrap items-center gap-2 rounded-lg border border-warn bg-orange-50 px-3 py-2 text-warn"
              role="alert"
            >
              连续 {d.stats.stallCount} 次跟进状态都是「待回复」，要转为暂缓或流失吗？
              <Button onClick={() => request(c, '暂缓')}>转暂缓</Button>
              <Button onClick={() => request(c, '流失')}>转流失</Button>
            </div>
          )}

          <Tabs
            tabs={['基本信息', '合作商品', '跟进记录', '样品', '变更历史']}
            value={tab}
            onChange={setTab}
          />

          {tab === '基本信息' && (
            <Section title="合作信息">
              <EditableFields
                specs={specs}
                row={c}
                display={(s, v) =>
                  s.type === 'money'
                    ? fmtMoney(v as number) || undefined
                    : s.type === 'date' && v
                      ? fmtDate(v as string)
                      : undefined
                }
                onSave={async (patch) => {
                  if (
                    !(await run(() => patchEntity('cooperation', c.id, patch, c.version), '已保存'))
                  )
                    throw new Error('保存失败，详见提示');
                }}
                extra={
                  <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                    删除合作
                  </Button>
                }
              />
              <p className="mb-0 mt-4 text-[13px] text-muted">
                对接联系人：{d.contact ? `${d.contact.name}（${d.contact.type}）` : '—'}，账号：
                {d.account?.accountId ?? '—'}
              </p>
            </Section>
          )}
          {tab === '合作商品' && <Products coopId={c.id} items={d.products} />}
          {tab === '跟进记录' && (
            <Section title="跟进时间线">
              <FollowTimeline items={d.followUps} />
            </Section>
          )}
          {tab === '样品' && (
            <Section title="关联的寄样单">
              {d.shipments.length === 0 ? (
                <Empty>还没有寄样单（寄样台账在阶段 4 完成）</Empty>
              ) : (
                d.shipments.map((s: Row) => (
                  <div key={s.id} className="border-b border-line py-2 last:border-0">
                    <Badge>{s.status}</Badge>{' '}
                    {s.shippedAt ? `寄出 ${fmtDate(s.shippedAt)}` : '未寄出'} {s.trackingNo ?? ''}
                  </div>
                ))
              )}
            </Section>
          )}
          {tab === '变更历史' && <HistoryList logs={d.history} />}
        </div>
      )}
      {follow && c && (
        <FollowUpDialog
          target={{ cooperationId: c.id }}
          coop={c}
          onClose={() => setFollow(false)}
        />
      )}
      {confirmDelete && c && (
        <ConfirmDialog
          title="删除合作"
          danger
          confirmLabel="删除"
          message="确定删除这条合作？可在变更历史里撤销。"
          onClose={() => setConfirmDelete(false)}
          onConfirm={async () => {
            if (
              await run(
                () => api('DELETE', `/e/cooperation/${c.id}?expectedVersion=${c.version}`),
                '已删除',
              )
            )
              onClose();
          }}
        />
      )}
      {dialog}
    </Drawer>
  );
}

function Products({ coopId, items }: { coopId: string; items: Row[] }) {
  const run = useAction();
  const [pq, setPq] = useState('');
  const prods = useQuery({
    queryKey: ['coop-prod-search', pq],
    enabled: pq.trim().length > 0,
    queryFn: () => api<{ rows: Row[] }>('GET', '/products' + qs({ q: pq, limit: 6 })),
  });
  return (
    <Section title="合作商品（佣金、直播价、机制按商品分别设置）">
      {items.length === 0 && <Empty>还没有商品</Empty>}
      {items.map((it) => (
        <ProductRow key={it.id} it={it} />
      ))}
      <div className="mt-3">
        <TextInput
          placeholder="搜索款号或名称添加商品"
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
    </Section>
  );
}

function ProductRow({ it }: { it: Row }) {
  const run = useAction();
  const [pct, setPct] = useState(it.commissionPct == null ? '' : String(it.commissionPct));
  const [price, setPrice] = useState(
    it.livePriceCents == null ? '' : String(it.livePriceCents / 100),
  );
  const [mech, setMech] = useState(it.mechanism ?? '');
  const [err, setErr] = useState('');
  async function save() {
    const p = pct.trim() === '' ? null : Number(pct);
    if (p !== null && (!Number.isFinite(p) || p < 0 || p > 100)) return setErr('佣金应为 0–100');
    const cents = yuanToCents(price);
    if (Number.isNaN(cents)) return setErr('直播价不是有效金额');
    setErr('');
    await run(
      () =>
        patchEntity(
          'cooperation_product',
          it.id,
          { commissionPct: p, livePriceCents: cents, mechanism: mech.trim() || null },
          it.version,
        ),
      '已保存',
    );
  }
  return (
    <div className="border-b border-line py-3 last:border-0">
      <div className="mb-2 flex items-center justify-between">
        <b>{it.product ? `${it.product.styleNo} ${it.product.name}` : '（商品已删除）'}</b>
        <Button
          variant="ghost"
          onClick={() => run(() => api('DELETE', `/e/cooperation_product/${it.id}`))}
        >
          移除
        </Button>
      </div>
      <div className="grid grid-cols-[110px_130px_1fr_auto] gap-2">
        <TextInput
          inputMode="decimal"
          aria-label="佣金（%）"
          placeholder="佣金 %"
          value={pct}
          onChange={(e) => setPct(e.target.value)}
        />
        <TextInput
          inputMode="decimal"
          aria-label="直播价（元）"
          placeholder="直播价 元"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
        />
        <TextInput
          aria-label="机制"
          placeholder="机制，如买一送一"
          value={mech}
          onChange={(e) => setMech(e.target.value)}
        />
        <Button onClick={save}>保存</Button>
      </div>
      {err && <p className="mb-0 mt-1 text-warn">{err}</p>}
    </div>
  );
}

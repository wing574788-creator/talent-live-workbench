import { useQuery } from '@tanstack/react-query';
import { useRegisterSelection } from '../lib/selection.ts';
import { useState, type ReactNode } from 'react';
import {
  COOP_AUTO_STAGES,
  COOP_FOLLOW_STAGES,
  COOP_MAIN_STAGES,
  COOP_MODES,
  PAYMENT_STATUSES,
} from '@workbench/shared';
import { CommissionTable } from '../components/CommissionTable.tsx';
import { EditableFields, type FieldSpec } from '../components/FormFields.tsx';
import { FollowItem, FollowUpDialog, QuickFollow } from '../components/FollowUp.tsx';
import { HistoryList, patchEntity, useAction, useDetail } from '../components/detail.tsx';
import { NewShipmentDialog, SamplesPanel } from '../components/samples.tsx';
import {
  Badge,
  Button,
  ConfirmDialog,
  Drawer,
  Empty,
  Field,
  Modal,
  Tabs,
  TextInput,
  cx,
} from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { fmtDate, fmtDateTime, fmtMoney, todayStr } from '../lib/format.ts';
import { useStageChange } from '../components/useStageChange.tsx';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const TABS = ['概览', '合作商品', '跟进与样品', '变更历史'];

/** 合作商品的佣金概况，如"3 款 · 佣金 20–25%" */
function commissionText(products: Row[]): { text: string; missing: boolean } {
  if (!products.length) return { text: '还没选商品', missing: true };
  const pcts = products.map((p) => p.commissionPct).filter((p) => p != null) as number[];
  const unset = products.length - pcts.length;
  if (!pcts.length) return { text: `${products.length} 款 · 佣金未定`, missing: true };
  const lo = Math.min(...pcts);
  const hi = Math.max(...pcts);
  return {
    text: `${products.length} 款 · 佣金 ${lo === hi ? lo : `${lo}–${hi}`}%${unset ? `（${unset} 款未定）` : ''}`,
    missing: unset > 0,
  };
}

export function CooperationDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  useRegisterSelection('cooperation', id);
  const run = useAction();
  const q = useDetail<Row>('cooperation', '/cooperations', id);
  const customDefs = useQuery({
    queryKey: ['field_defs', 'cooperation'],
    queryFn: () => api<{ rows: Row[] }>('GET', '/e/field_def?f.entity=cooperation'),
  });
  const { request, dialog } = useStageChange();
  const [tab, setTab] = useState('概览');
  const [quick, setQuick] = useState(false);
  const [fullFollow, setFullFollow] = useState(false);
  const [samples, setSamples] = useState(false);
  const [newShipment, setNewShipment] = useState(false);
  const [liveDateOpen, setLiveDateOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const d = q.data;
  const c = d?.cooperation;

  const save = async (patch: Record<string, unknown>) => {
    if (!(await run(() => patchEntity('cooperation', c!.id, patch, c!.version), '已保存')))
      throw new Error('保存失败，详见提示');
  };
  const display = (s: FieldSpec, v: unknown) =>
    s.type === 'money'
      ? fmtMoney(v as number) || undefined
      : s.type === 'date' && v
        ? fmtDate(v as string)
        : undefined;

  return (
    <Drawer
      title={
        c && d ? `${d.influencer?.nickname ?? '（已删除）'} · ${d.account?.platform ?? ''}` : '合作'
      }
      onClose={onClose}
      width={760}
    >
      {q.isPending && <Empty>加载中…</Empty>}
      {q.isError && <Empty>{(q.error as Error).message}</Empty>}
      {d && c && (
        <div className="flex flex-col gap-4">
          <StageHeader
            c={c}
            d={d}
            onStage={(s) => request(c, s)}
            onDelete={() => setConfirmDelete(true)}
          />
          <NextStep
            c={c}
            d={d}
            onFollow={() => setQuick(true)}
            onCommission={() => setTab('合作商品')}
            onShipment={() => setNewShipment(true)}
            onSamples={() => setSamples(true)}
            onLiveDate={() => setLiveDateOpen(true)}
            onDone={() => request(c, '完成')}
            onPause={(s) => request(c, s)}
          />

          <Tabs tabs={TABS} value={tab} onChange={setTab} />

          {tab === '概览' && (
            <Overview
              c={c}
              d={d}
              customDefs={customDefs.data?.rows ?? []}
              display={display}
              onSave={save}
              onCommission={() => setTab('合作商品')}
            />
          )}
          {tab === '合作商品' && (
            <Block title="合作商品" hint="佣金、直播价、机制按商品分别设置">
              <CommissionTable coopId={c.id} items={d.products} />
            </Block>
          )}
          {tab === '跟进与样品' && (
            <Block
              title="跟进与样品"
              actions={
                <>
                  <Button onClick={() => setQuick(true)}>记跟进</Button>
                  <Button onClick={() => setNewShipment(true)}>登记寄样</Button>
                </>
              }
            >
              <Timeline followUps={d.followUps} shipments={d.shipments} />
            </Block>
          )}
          {tab === '变更历史' && <HistoryList logs={d.history} />}
        </div>
      )}
      {quick && c && (
        <QuickFollow
          target={{ cooperationId: c.id }}
          coop={c}
          title={d?.influencer?.nickname ?? ''}
          onClose={() => setQuick(false)}
          onExpand={() => setFullFollow(true)}
          onPause={async () => {
            const fresh = await api<{ cooperation: Row }>('GET', `/cooperations/${c.id}`);
            request(fresh.cooperation, '暂缓');
          }}
        />
      )}
      {fullFollow && c && (
        <FollowUpDialog
          target={{ cooperationId: c.id }}
          coop={c}
          onClose={() => setFullFollow(false)}
        />
      )}
      {newShipment && c && (
        <NewShipmentDialog
          influencerId={c.influencerId}
          defaultCoopId={c.id}
          onClose={() => setNewShipment(false)}
        />
      )}
      {samples && c && (
        <Drawer
          title={`${d?.influencer?.nickname ?? ''} · 样品台账`}
          width={820}
          onClose={() => setSamples(false)}
        >
          <SamplesPanel influencerId={c.influencerId} />
        </Drawer>
      )}
      {liveDateOpen && c && <LiveDateDialog c={c} onClose={() => setLiveDateOpen(false)} />}
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

// ───────────── 头部：阶段步骤条（唯一改阶段的入口） ─────────────
function StageHeader({
  c,
  d,
  onStage,
  onDelete,
}: {
  c: Row;
  d: Row;
  onStage: (s: string) => void;
  onDelete: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const idx = (COOP_MAIN_STAGES as readonly string[]).indexOf(c.stage);
  const side = idx < 0;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <ol
          aria-label="阶段（点击切换）"
          className="m-0 flex min-w-0 flex-1 list-none flex-wrap gap-1 p-0"
        >
          {COOP_MAIN_STAGES.map((s, i) => {
            const auto = COOP_AUTO_STAGES.includes(s);
            const done = !side && i < idx;
            return (
              <li key={s}>
                <button
                  type="button"
                  aria-current={s === c.stage ? 'step' : undefined}
                  title={auto ? `${s}：通常由寄样和开播日自动推进，也可以手动改` : s}
                  onClick={() => onStage(s)}
                  className={cx(
                    'min-h-8 cursor-pointer rounded-full border px-3 text-xs transition-colors',
                    s === c.stage
                      ? 'border-transparent bg-ink font-extrabold text-white'
                      : done
                        ? 'border-transparent bg-brand-soft font-bold text-brand-dark'
                        : 'border-line bg-surface font-medium text-muted hover:bg-bg',
                  )}
                >
                  {done && '✓ '}
                  {s}
                </button>
              </li>
            );
          })}
        </ol>
        <div className="relative shrink-0">
          <Button
            aria-label="更多操作"
            aria-expanded={menu}
            className="!min-h-8 !px-3"
            onClick={() => setMenu(!menu)}
          >
            ···
          </Button>
          {menu && (
            <div
              role="menu"
              className="absolute right-0 top-10 z-20 flex w-36 flex-col rounded-2xl bg-surface p-1.5 shadow-xl"
              onMouseLeave={() => setMenu(false)}
            >
              {['暂缓', '流失', '放弃'].map((s) => (
                <MenuItem
                  key={s}
                  disabled={c.stage === s}
                  onClick={() => {
                    setMenu(false);
                    onStage(s);
                  }}
                >
                  转为{s}
                </MenuItem>
              ))}
              <MenuItem
                danger
                onClick={() => {
                  setMenu(false);
                  onDelete();
                }}
              >
                删除合作
              </MenuItem>
            </div>
          )}
        </div>
      </div>
      {side && (
        <div className="rounded-2xl bg-bg px-4 py-2.5 text-sm">
          当前：<b>{c.stage}</b>
          {c.lostReason && <span className="text-muted"> · 原因：{c.lostReason}</span>}
          <span className="text-muted">。点上面的阶段可以恢复。</span>
        </div>
      )}
      <StatusLine c={c} d={d} />
    </div>
  );
}

function MenuItem({
  children,
  onClick,
  danger,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={cx(
        'min-h-9 cursor-pointer rounded-xl border-0 bg-transparent px-3 text-left text-sm hover:bg-bg disabled:cursor-default disabled:opacity-40',
        danger ? 'text-warn' : 'text-ink',
      )}
    >
      {children}
    </button>
  );
}

/** 一句话状态：待建联/洽谈中看跟进，之后看开播和佣金 */
function StatusLine({ c, d }: { c: Row; d: Row }) {
  const today = todayStr();
  const parts: ReactNode[] = [];
  if (COOP_FOLLOW_STAGES.includes(c.stage)) {
    parts.push(
      d.stats.followCount === 0
        ? '还没有跟进'
        : `第 ${d.stats.followCount} 次跟进${c.followStatus ? ` · ${c.followStatus}` : ''} · ${d.stats.daysSinceFollow === 0 ? '今天' : `${d.stats.daysSinceFollow} 天前`}`,
    );
    if (c.nextFollowDate)
      parts.push(
        <span className={c.nextFollowDate <= today ? 'font-bold text-warn' : ''}>
          下次跟进 {fmtDate(c.nextFollowDate)}
          {c.nextFollowDate < today ? '（已逾期）' : c.nextFollowDate === today ? '（今天）' : ''}
        </span>,
      );
  } else {
    parts.push(c.liveDate ? `开播 ${fmtDate(c.liveDate)}` : '档期待定');
    parts.push(commissionText(d.products).text);
  }
  return (
    <div className="flex flex-wrap items-center gap-x-2 text-sm text-ink-2">
      {parts.map((p, i) => (
        <span key={i} className="flex items-center gap-2">
          {i > 0 && <span className="text-muted">·</span>}
          {p}
        </span>
      ))}
    </div>
  );
}

// ───────────── 下一步：按阶段给一个主按钮 ─────────────
function NextStep({
  c,
  d,
  onFollow,
  onCommission,
  onShipment,
  onSamples,
  onLiveDate,
  onDone,
  onPause,
}: {
  c: Row;
  d: Row;
  onFollow: () => void;
  onCommission: () => void;
  onShipment: () => void;
  onSamples: () => void;
  onLiveDate: () => void;
  onDone: () => void;
  onPause: (s: string) => void;
}) {
  const today = todayStr();
  const comm = commissionText(d.products);
  let hint: ReactNode;
  let action: { label: string; run: () => void };
  let warn = false;
  switch (c.stage) {
    case '待建联':
    case '洽谈中':
      warn = !!c.nextFollowDate && c.nextFollowDate <= today;
      hint =
        c.stage === '待建联'
          ? '联系上了就记一笔，或者点上面的"洽谈中"'
          : warn
            ? '跟进日到了：记一笔，并定下一次'
            : '谈到哪了随时记一笔，记的时候顺便定下次跟进日期';
      action = { label: '记一笔跟进', run: onFollow };
      break;
    case '已确认':
      if (comm.missing) {
        hint = `${comm.text}，先把佣金定下来`;
        warn = true;
        action = { label: '补佣金', run: onCommission };
      } else {
        hint = '佣金已定，下一步登记寄样（建好寄样单自动转"待寄样"）';
        action = { label: '登记寄样', run: onShipment };
      }
      break;
    case '待寄样':
      hint = '样衣寄出后自动转"已排期"';
      action = { label: '去寄出', run: onSamples };
      break;
    case '已排期':
      if (!c.liveDate) {
        hint = '还没有开播日：填上后，开播日一过自动转"已开播"';
        warn = true;
        action = { label: '填开播日', run: onLiveDate };
      } else {
        hint = `开播 ${fmtDate(c.liveDate)}，开播日一过自动转"已开播"`;
        action = { label: '改开播日', run: onLiveDate };
      }
      break;
    case '已开播':
    case '待退样':
      hint = '这场合作的样品全部退回或核销后，自动转"待复盘"';
      action = { label: '登记退回', run: onSamples };
      break;
    case '待复盘':
      hint = '复盘完了就标记完成';
      action = { label: '标记完成', run: onDone };
      break;
    default:
      return null;
  }
  return (
    <div
      className={cx(
        'flex flex-wrap items-center justify-between gap-3 rounded-2xl px-4 py-3',
        warn ? 'bg-amber-soft text-[#8a4b00]' : 'bg-brand-soft text-brand-dark',
      )}
    >
      <span className="text-sm font-bold">
        <span className="mr-2 text-xs font-extrabold opacity-70">下一步</span>
        {hint}
      </span>
      <span className="flex gap-2">
        {d.stats.stalled && c.stage === '洽谈中' && (
          <Button onClick={() => onPause('暂缓')}>
            连续 {d.stats.stallCount} 次待回复 · 转暂缓
          </Button>
        )}
        <Button variant="primary" onClick={action.run}>
          {action.label}
        </Button>
      </span>
    </div>
  );
}

// ───────────── 概览：谈判 / 排期 / 对接，其余收进"更多" ─────────────
function Overview({
  c,
  d,
  customDefs,
  display,
  onSave,
  onCommission,
}: {
  c: Row;
  d: Row;
  customDefs: Row[];
  display: (s: FieldSpec, v: unknown) => ReactNode;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
  onCommission: () => void;
}) {
  const comm = commissionText(d.products);
  const deal: FieldSpec[] = [
    { key: 'mode', label: '合作模式', type: 'select', options: [...COOP_MODES] },
    ...(c.mode === '坑位费+佣金'
      ? ([
          { key: 'slotFeeCents', label: '坑位费', type: 'money' },
          {
            key: 'paymentStatus',
            label: '付款状态',
            type: 'select',
            options: [...PAYMENT_STATUSES],
          },
        ] as FieldSpec[])
      : []),
  ];
  const schedule: FieldSpec[] = [
    { key: 'liveDate', label: '开播日期', type: 'date' },
    { key: 'liveSlot', label: '开播时段', type: 'text', placeholder: '如 20:00-23:00' },
    { key: 'linkMethod', label: '挂链方式', type: 'text' },
  ];
  const more: FieldSpec[] = [
    { key: 'channel', label: '合作通道', type: 'text' },
    { key: 'reportStatus', label: '报备状态', type: 'text' },
    ...(c.stage === '流失' || c.stage === '放弃'
      ? ([{ key: 'lostReason', label: '流失/放弃原因', type: 'text', wide: true }] as FieldSpec[])
      : []),
    ...customDefs.map<FieldSpec>((f) => ({
      key: f.key,
      label: f.label,
      custom: true,
      type: f.type === 'multiselect' ? 'tags' : f.type,
      options: f.options ?? undefined,
    })),
  ];
  return (
    <div className="flex flex-col gap-3">
      <Block title="谈判">
        <EditableFields specs={deal} row={c} display={display} onSave={onSave} />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-bg px-4 py-2.5">
          <span className={comm.missing ? 'font-bold text-[#8a4b00]' : ''}>{comm.text}</span>
          <Button variant="ghost" onClick={onCommission}>
            {comm.missing ? '去定佣金' : '改佣金'}
          </Button>
        </div>
      </Block>
      <Block title="排期">
        <EditableFields specs={schedule} row={c} display={display} onSave={onSave} />
      </Block>
      <Block title="对接">
        <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-3">
          <div>
            <dt className="text-[13px] text-muted">对接联系人</dt>
            <dd className="m-0">
              {d.contact ? (
                `${d.contact.name}（${d.contact.type}）`
              ) : (
                <span className="text-muted">—</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-[13px] text-muted">平台账号</dt>
            <dd className="m-0">
              {d.account ? `${d.account.platform} · ${d.account.accountId}` : '—'}
            </dd>
          </div>
        </dl>
      </Block>
      <details className="rounded-[28px] bg-surface px-6 py-4 shadow-[0_1px_0_var(--color-line)]">
        <summary className="cursor-pointer font-extrabold">
          更多信息
          <span className="ml-2 text-sm font-medium text-muted">
            合作通道、报备状态{customDefs.length ? '、自定义字段' : ''}
          </span>
        </summary>
        <div className="mt-3">
          <EditableFields specs={more} row={c} display={display} onSave={onSave} />
        </div>
      </details>
    </div>
  );
}

function Block({
  title,
  hint,
  actions,
  children,
}: {
  title: string;
  hint?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-[28px] bg-surface px-6 py-5 shadow-[0_1px_0_var(--color-line)]">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="m-0 text-base font-extrabold">
          {title}
          {hint && <span className="ml-2 text-sm font-medium text-muted">{hint}</span>}
        </h3>
        {actions && <div className="flex gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

// ───────────── 跟进与样品：一条时间线 ─────────────
type TimelineItem = { at: string; key: string; f?: Row; s?: Row };

function Timeline({ followUps, shipments }: { followUps: Row[]; shipments: Row[] }) {
  const items: TimelineItem[] = [
    ...followUps.map((f) => ({ at: String(f.occurredAt), key: `f-${f.id}`, f })),
    ...shipments.map((s) => ({ at: String(s.shippedAt ?? s.createdAt), key: `s-${s.id}`, s })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  if (!items.length) return <Empty>还没有跟进记录和寄样单</Empty>;
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {items.map((it) =>
        it.f ? (
          <FollowItem key={it.key} f={it.f} />
        ) : (
          <li
            key={it.key}
            className="flex flex-wrap items-center gap-2 rounded-2xl border border-dashed border-line-strong px-4 py-3 text-sm"
          >
            <Badge tone={it.s!.status === '待寄样' ? 'orange' : 'green'}>
              寄样 · {it.s!.status}
            </Badge>
            <span className="text-muted">
              {it.s!.shippedAt
                ? `寄出 ${fmtDate(it.s!.shippedAt)}`
                : `创建于 ${fmtDateTime(it.s!.createdAt)}`}
            </span>
            {it.s!.trackingNo && <span>单号 {it.s!.trackingNo}</span>}
            {it.s!.dueBackDate && (
              <span className="text-muted">应寄回 {fmtDate(it.s!.dueBackDate)}</span>
            )}
          </li>
        ),
      )}
    </ul>
  );
}

// ───────────── 填/改开播日 ─────────────
function LiveDateDialog({ c, onClose }: { c: Row; onClose: () => void }) {
  const run = useAction();
  const [date, setDate] = useState<string>(c.liveDate ?? '');
  const [slot, setSlot] = useState<string>(c.liveSlot ?? '');
  return (
    <Modal
      title="开播日期"
      onClose={onClose}
      width={420}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            disabled={!date}
            onClick={async () => {
              if (
                await run(
                  () =>
                    patchEntity(
                      'cooperation',
                      c.id,
                      { liveDate: date, liveSlot: slot.trim() || null },
                      c.version,
                    ),
                  '开播日已保存',
                )
              )
                onClose();
            }}
          >
            保存
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="开播日期 *">
          <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="开播时段">
          <TextInput
            value={slot}
            placeholder="如 20:00-23:00"
            onChange={(e) => setSlot(e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}

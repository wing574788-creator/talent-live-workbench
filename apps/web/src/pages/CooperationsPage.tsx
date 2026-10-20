import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  COOP_FOLLOW_STAGES,
  COOP_MAIN_STAGES,
  COOP_MODES,
  COOP_SIDE_STAGES,
  COOP_STAGES,
} from '@workbench/shared';
import { EntityList, type Col } from '../components/EntityList.tsx';
import { FollowUpDialog, QuickFollow, useSettings } from '../components/FollowUp.tsx';
import { useAction } from '../components/detail.tsx';
import { Badge, Button, Field, Modal, Select, TextInput } from '../components/ui.tsx';
import { api, qs } from '../lib/api.ts';
import { fmtDate, todayStr } from '../lib/format.ts';
import { CooperationDrawer } from './CooperationDrawer.tsx';
import { useStageChange } from '../components/useStageChange.tsx';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const pctText = (c: Row) =>
  c.productCount === 0
    ? '未选商品'
    : c.commissionMin == null
      ? '佣金未确认'
      : `佣金 ${c.commissionMin === c.commissionMax ? c.commissionMin : `${c.commissionMin}–${c.commissionMax}`}%${c.commissionUnset ? '（部分未设）' : ''}`;

/** 下次跟进日期到了（只对待建联/洽谈中有意义，其他阶段的旧日期不算） */
const isDue = (c: Row, today: string) =>
  COOP_FOLLOW_STAGES.includes(c.stage) && !!c.nextFollowDate && c.nextFollowDate <= today;

const followLine = (c: Row) =>
  c.followCount === 0
    ? '还没有跟进'
    : `第 ${c.followCount} 次跟进 · ${c.followStatus ?? '无状态'} · ${c.daysSinceFollow === 0 ? '今天' : `${c.daysSinceFollow} 天前`}`;

// ───────────── 页面 ─────────────
export function CooperationsPage() {
  const [view, setView] = useState<'board' | 'list'>(
    () => (localStorage.getItem('coop-view') as 'board' | 'list') ?? 'board',
  );
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [quick, setQuick] = useState<Row | null>(null);
  const [fullFollow, setFullFollow] = useState<Row | null>(null);
  const { request, dialog } = useStageChange();
  useEffect(() => localStorage.setItem('coop-view', view), [view]);
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="m-0 text-3xl font-extrabold tracking-tight">合作</h1>
          <div className="mt-1 text-sm text-muted">
            {view === 'board' ? '拖动卡片换阶段，点开看详情' : '用表格看全部合作，可排序和筛选'}
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          <div className="flex rounded-2xl border border-line bg-surface p-1">
            {(
              [
                ['board', '看板'],
                ['list', '列表'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                aria-pressed={view === k}
                onClick={() => setView(k)}
                className={`min-h-9 cursor-pointer rounded-xl border-0 px-4 text-sm ${view === k ? 'bg-ink font-bold text-white' : 'bg-transparent font-medium text-ink-2'}`}
              >
                {label}
              </button>
            ))}
          </div>
          <Button variant="primary" className="!min-h-11" onClick={() => setCreating(true)}>
            + 新建合作
          </Button>
        </div>
      </div>
      {view === 'board' ? (
        <Board onOpen={setOpenId} onQuick={setQuick} />
      ) : (
        <ListView onOpen={setOpenId} onQuick={setQuick} />
      )}
      {quick && (
        <QuickFollow
          target={{ cooperationId: quick.id }}
          coop={quick}
          title={quick.influencerNickname}
          onClose={() => setQuick(null)}
          onExpand={() => setFullFollow(quick)}
          onPause={async () => {
            // 记跟进会更新合作（版本号变了），先取最新的再改阶段
            const fresh = await api<{ cooperation: Row }>('GET', `/cooperations/${quick.id}`);
            request(fresh.cooperation, '暂缓');
          }}
        />
      )}
      {fullFollow && (
        <FollowUpDialog
          target={{ cooperationId: fullFollow.id }}
          coop={fullFollow}
          onClose={() => setFullFollow(null)}
        />
      )}
      {dialog}
      {creating && (
        <NewCooperation
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setOpenId(id);
          }}
        />
      )}
      {openId && <CooperationDrawer id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

// ───────────── 看板 ─────────────
function Board({ onOpen, onQuick }: { onOpen: (id: string) => void; onQuick: (c: Row) => void }) {
  const [q, setQ] = useState('');
  const [dueOnly, setDueOnly] = useState(false);
  const { request, dialog } = useStageChange();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const data = useQuery({
    queryKey: ['board', q],
    queryFn: () =>
      api<{ rows: Row[] }>(
        'GET',
        '/cooperations' + qs({ q, limit: 500, sort: 'nextFollowDate', dir: 'asc' }),
      ),
    placeholderData: (p) => p,
  });
  const today = todayStr();
  const all = data.data?.rows ?? [];
  const rows = dueOnly ? all.filter((c) => isDue(c, today)) : all;

  function onDragEnd(e: DragEndEvent) {
    const coop = all.find((c) => c.id === e.active.id);
    if (coop && e.over) request(coop, String(e.over.id));
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="w-64">
          <TextInput
            type="search"
            aria-label="搜索"
            placeholder="搜索达人昵称、账号 ID"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <label className="flex cursor-pointer items-center gap-2">
          <input type="checkbox" checked={dueOnly} onChange={(e) => setDueOnly(e.target.checked)} />
          只看今天及已逾期要跟进的
        </label>
      </div>
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <div className="flex gap-3 overflow-x-auto pb-2">
          {COOP_MAIN_STAGES.map((stage) => (
            <Column
              key={stage}
              stage={stage}
              cards={rows.filter((c) => c.stage === stage)}
              today={today}
              onOpen={onOpen}
              onQuick={onQuick}
            />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-muted">旁支（拖到这里）：</span>
          {COOP_SIDE_STAGES.map((stage) => (
            <SideDrop
              key={stage}
              stage={stage}
              count={all.filter((c) => c.stage === stage).length}
            />
          ))}
          <span className="text-[13px] text-muted">旁支的合作在「列表」视图里查看</span>
        </div>
      </DndContext>
      {dialog}
    </div>
  );
}

function Column({
  stage,
  cards,
  today,
  onOpen,
  onQuick,
}: {
  stage: string;
  cards: Row[];
  today: string;
  onOpen: (id: string) => void;
  onQuick: (c: Row) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage });
  return (
    <section
      ref={setNodeRef}
      aria-label={stage}
      className={`flex w-[270px] shrink-0 flex-col gap-3 rounded-3xl bg-[#e9e7f7] p-3 ${isOver ? 'outline-2 -outline-offset-2 outline-brand outline-dashed' : ''}`}
    >
      <h3 className="m-0 flex items-center justify-between px-1.5 pt-1 text-sm font-extrabold">
        <span className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="size-2.5 rounded-full"
            style={{ background: STAGE_DOT[stage] ?? '#8e88ff' }}
          />
          {stage}
        </span>
        <span className="min-w-6 rounded-full bg-surface px-2 text-center text-xs font-extrabold">
          {cards.length}
        </span>
      </h3>
      {isOver && (
        <div className="rounded-[20px] border-2 border-dashed border-[#8e88ff] bg-[#f3f2ff] p-3.5 text-center text-[13px] font-bold text-brand-dark">
          松手放到这里
        </div>
      )}
      {cards.map((c) => (
        <CardView key={c.id} c={c} today={today} onOpen={onOpen} onQuick={onQuick} />
      ))}
    </section>
  );
}

/** 每个阶段一个状态色点 */
const STAGE_DOT: Record<string, string> = {
  待建联: '#a3a1bd',
  洽谈中: '#4f46e5',
  已确认: '#2fbf8f',
  待寄样: '#ffb020',
  已排期: '#8e88ff',
  已开播: '#ff6f59',
  待退样: '#e0568a',
  待复盘: '#5aa9e6',
  完成: '#16152b',
};

const AVATARS = [
  ['#ffd3c9', '#8a2b16'],
  ['#cff5e7', '#0b6b4f'],
  ['#d9d5ff', '#3730a3'],
  ['#ffe9c7', '#8a4b00'],
];
/** 按昵称固定一个头像配色，同一个达人在哪都是同一个颜色 */
function avatarStyle(name: string) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % AVATARS.length;
  const [bg, fg] = AVATARS[h]!;
  return { background: bg, color: fg };
}

function SideDrop({ stage, count }: { stage: string; count: number }) {
  const { setNodeRef, isOver } = useDroppable({ id: stage });
  return (
    <div
      ref={setNodeRef}
      className={`min-w-28 rounded-lg border border-dashed px-4 py-2 text-center ${isOver ? 'border-brand bg-brand-soft' : 'border-line-strong'}`}
    >
      {stage} <span className="text-muted">{count}</span>
    </div>
  );
}

function CardView({
  c,
  today,
  onOpen,
  onQuick,
}: {
  c: Row;
  today: string;
  onOpen: (id: string) => void;
  onQuick: (c: Row) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: c.id });
  const overdue = isDue(c, today);
  const scheduled = ['已排期', '已开播', '待退样', '待复盘', '完成'].includes(c.stage);
  return (
    <article
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={() => onOpen(c.id)}
      style={{
        transform: transform ? `translate(${transform.x}px, ${transform.y}px)` : undefined,
        zIndex: isDragging ? 30 : undefined,
      }}
      className={`group relative cursor-grab rounded-[20px] bg-surface p-4 text-[13px] shadow-[0_2px_0_var(--color-line-strong)] ${isDragging ? 'rotate-1 opacity-90 shadow-xl' : ''}`}
    >
      <QuickFollowButton c={c} onQuick={onQuick} />
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-extrabold"
          style={avatarStyle(String(c.influencerNickname))}
        >
          {String(c.influencerNickname)
            .replace(/^示例达人/, '')
            .slice(0, 1)}
        </span>
        <div className="min-w-0 flex-1">
          <b className="block truncate text-sm">{c.influencerNickname}</b>
          {c.platform && <span className="text-xs text-muted">{c.platform}</span>}
        </div>
      </div>
      <div className="mt-1 text-muted">{followLine(c)}</div>
      {c.nextFollowDate && COOP_FOLLOW_STAGES.includes(c.stage) && (
        <div className={overdue ? 'text-warn' : 'text-muted'}>
          下次跟进 {fmtDate(c.nextFollowDate)}
          {overdue ? '（待跟进）' : ''}
        </div>
      )}
      {(scheduled || c.liveDate) && (
        <div className="text-muted">{c.liveDate ? `开播 ${fmtDate(c.liveDate)}` : '档期待定'}</div>
      )}
      <div className={c.productCount && c.commissionMin == null ? 'text-warn' : 'text-muted'}>
        {c.productCount > 0 && `${c.productCount} 款 · `}
        {pctText(c)}
      </div>
      {c.stalled && c.stage === '洽谈中' && (
        <div className="mt-1">
          <Badge tone="orange">连续 {c.stallCount} 次待回复，要不要转暂缓/流失？</Badge>
        </div>
      )}
    </article>
  );
}

/** 卡片右上角的"记跟进"按钮：悬停或键盘聚焦时出现，不触发拖拽和打开详情 */
function QuickFollowButton({ c, onQuick }: { c: Row; onQuick: (c: Row) => void }) {
  return (
    <button
      type="button"
      title="记跟进"
      aria-label={`记跟进：${c.influencerNickname}`}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onQuick(c);
      }}
      className="absolute right-3 top-3 flex size-8 cursor-pointer items-center justify-center rounded-full border-0 bg-ink text-lime opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
    >
      <svg
        aria-hidden="true"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 20h4L19 9l-4-4L4 16z" />
        <path d="M13.5 6.5l4 4" />
      </svg>
    </button>
  );
}

// ───────────── 列表 ─────────────
function ListView({
  onOpen,
  onQuick,
}: {
  onOpen: (id: string) => void;
  onQuick: (c: Row) => void;
}) {
  const settings = useSettings();
  const { request, dialog } = useStageChange();
  const today = todayStr();
  const cols: Col<Row>[] = [
    { id: 'influencer', header: '达人', cell: (r) => <b>{r.influencerNickname}</b> },
    {
      id: 'account',
      header: '账号',
      cell: (r) => (
        <>
          {r.platform && <Badge>{r.platform}</Badge>} {r.accountId}
        </>
      ),
    },
    {
      id: 'stage',
      header: '阶段',
      sort: 'stage',
      cell: (r) => (
        <span onClick={(e) => e.stopPropagation()}>
          <Select
            aria-label={`${r.influencerNickname} 的阶段`}
            className="!w-28"
            value={r.stage}
            onChange={(e) => request(r, e.target.value)}
          >
            {COOP_STAGES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Select>
        </span>
      ),
    },
    {
      id: 'follow',
      header: '跟进',
      cell: (r) =>
        r.stage === '洽谈中' ? followLine(r) : r.followCount ? `${r.followCount} 次` : '',
    },
    {
      id: 'next',
      header: '下次跟进',
      sort: 'nextFollowDate',
      cell: (r) => (
        <span className={isDue(r, today) ? 'text-warn' : ''}>
          {COOP_FOLLOW_STAGES.includes(r.stage) ? fmtDate(r.nextFollowDate) : ''}
        </span>
      ),
    },
    { id: 'live', header: '开播日', sort: 'liveDate', cell: (r) => fmtDate(r.liveDate) },
    { id: 'commission', header: '佣金', cell: (r) => pctText(r) },
    { id: 'products', header: '商品', defaultHidden: true, cell: (r) => r.productNames.join('、') },
    { id: 'lost', header: '流失/放弃原因', defaultHidden: true, cell: (r) => r.lostReason ?? '' },
    {
      id: 'quick',
      header: '',
      cell: (r) => (
        <Button
          className="!min-h-8 !px-3 !text-xs"
          onClick={(e) => {
            e.stopPropagation();
            onQuick(r);
          }}
        >
          记跟进
        </Button>
      ),
    },
    {
      id: 'updatedAt',
      header: '更新时间',
      sort: 'updatedAt',
      defaultHidden: true,
      cell: (r) => fmtDate(r.updatedAt),
    },
  ];
  return (
    <>
      <EntityList
        entity="cooperation"
        endpoint="/cooperations"
        cols={cols}
        filters={[
          { key: 'stage', label: '阶段', options: [...COOP_STAGES] },
          {
            key: 'followStatus',
            label: '跟进状态',
            options: settings.data?.followStatuses.map((s) => s.value) ?? [],
          },
          { key: 'mode', label: '合作模式', options: [...COOP_MODES] },
        ]}
        searchPlaceholder="搜索达人昵称、账号 ID"
        onOpen={onOpen}
      />
      {dialog}
    </>
  );
}

// ───────────── 新建合作 ─────────────
function NewCooperation({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const run = useAction();
  const settings = useSettings();
  const [q, setQ] = useState('');
  const [inf, setInf] = useState<Row | null>(null);
  const [accountId, setAccountId] = useState('');
  const [contactId, setContactId] = useState('');
  const [mode, setMode] = useState<string>('纯佣');
  const [stage, setStage] = useState<string>('待建联');
  const [nextDate, setNextDate] = useState('');
  const [followStatus, setFollowStatus] = useState('');
  const [liveDate, setLiveDate] = useState('');
  const [pq, setPq] = useState('');
  const [items, setItems] = useState<{ product: Row; commissionPct: string }[]>([]);
  const [err, setErr] = useState('');

  const found = useQuery({
    queryKey: ['coop-inf-search', q],
    enabled: !inf && q.trim().length > 0,
    queryFn: () => api<{ rows: Row[] }>('GET', '/influencers' + qs({ q, limit: 8 })),
  });
  const detail = useQuery({
    queryKey: ['influencer', inf?.id],
    enabled: !!inf,
    queryFn: () => api<Row>('GET', `/influencers/${inf!.id}`),
  });
  const prods = useQuery({
    queryKey: ['coop-prod-search', pq],
    enabled: pq.trim().length > 0,
    queryFn: () => api<{ rows: Row[] }>('GET', '/products' + qs({ q: pq, limit: 6 })),
  });
  useEffect(() => {
    const a = detail.data?.accounts;
    if (a?.length) setAccountId(a[0].id);
    const primary = detail.data?.contacts.find((l: Row) => l.isPrimary);
    setContactId(primary?.contactId ?? '');
  }, [detail.data]);

  async function submit() {
    if (!inf) return setErr('请先选择达人');
    if (!accountId) return setErr('该达人还没有平台账号，请先到达人详情里添加');
    if (stage === '洽谈中' && !nextDate) return setErr('洽谈中的合作必须有下次跟进日期');
    const pcts = items.map((i) => (i.commissionPct.trim() === '' ? null : Number(i.commissionPct)));
    if (pcts.some((p) => p !== null && (!Number.isFinite(p) || p < 0 || p > 100)))
      return setErr('佣金应为 0–100 的数字');
    setErr('');
    const res = await run(
      () =>
        api('POST', '/cooperations', {
          cooperation: {
            influencerId: inf.id,
            platformAccountId: accountId,
            contactId: contactId || null,
            mode,
            stage,
            nextFollowDate: nextDate || null,
            followStatus: followStatus || null,
            liveDate: liveDate || null,
          },
          products: items.map((i, idx) => ({ productId: i.product.id, commissionPct: pcts[idx] })),
        }),
      '合作已创建',
    );
    if (res) onCreated(res.row.id);
  }

  return (
    <Modal
      title="新建合作"
      onClose={onClose}
      width={700}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={submit}>
            创建
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {!inf ? (
          <>
            <Field label="选择达人 *">
              <TextInput
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="搜索昵称或账号 ID"
                autoFocus
              />
            </Field>
            {found.data?.rows.map((r) => (
              <button
                key={r.id}
                type="button"
                className="cursor-pointer rounded-lg border border-line bg-surface px-3 py-2 text-left hover:bg-bg"
                onClick={() => setInf(r)}
              >
                <b>{r.nickname}</b>{' '}
                <span className="text-muted">
                  {r.accounts.map((a: Row) => `${a.platform}:${a.accountId}`).join('、')}
                </span>
              </button>
            ))}
          </>
        ) : (
          <>
            <div className="flex items-center justify-between rounded-lg bg-bg px-3 py-2">
              <span>
                达人：<b>{inf.nickname}</b>
              </span>
              <Button
                variant="ghost"
                onClick={() => {
                  setInf(null);
                  setQ('');
                }}
              >
                换一个
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="平台账号 *">
                <Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                  {detail.data?.accounts.map((a: Row) => (
                    <option key={a.id} value={a.id}>
                      {a.platform} · {a.accountId}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="对接联系人">
                <Select value={contactId} onChange={(e) => setContactId(e.target.value)}>
                  <option value="">—</option>
                  {detail.data?.contacts.map((l: Row) => (
                    <option key={l.contactId} value={l.contactId}>
                      {l.contact.name}（{l.contact.type}）
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="合作模式">
                <Select value={mode} onChange={(e) => setMode(e.target.value)}>
                  {COOP_MODES.map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </Select>
              </Field>
              <Field label="阶段">
                <Select value={stage} onChange={(e) => setStage(e.target.value)}>
                  {COOP_MAIN_STAGES.map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </Select>
              </Field>
              {stage === '洽谈中' && (
                <>
                  <Field label="下次跟进日期 *">
                    <TextInput
                      type="date"
                      value={nextDate}
                      onChange={(e) => setNextDate(e.target.value)}
                    />
                  </Field>
                  <Field label="跟进状态">
                    <Select value={followStatus} onChange={(e) => setFollowStatus(e.target.value)}>
                      <option value="">—</option>
                      {settings.data?.followStatuses.map((s) => (
                        <option key={s.id}>{s.value}</option>
                      ))}
                    </Select>
                  </Field>
                </>
              )}
              <Field label="开播日期">
                <TextInput
                  type="date"
                  value={liveDate}
                  onChange={(e) => setLiveDate(e.target.value)}
                />
              </Field>
            </div>
            <div>
              <h4 className="mb-2 mt-0">合作商品（每个商品可设不同佣金）</h4>
              {items.map((it, i) => (
                <div key={it.product.id} className="mb-2 flex items-center gap-2">
                  <span className="flex-1">
                    {it.product.styleNo} {it.product.name}
                  </span>
                  <TextInput
                    className="!w-28"
                    inputMode="decimal"
                    placeholder="佣金 %"
                    value={it.commissionPct}
                    onChange={(e) =>
                      setItems(
                        items.map((x, j) =>
                          j === i ? { ...x, commissionPct: e.target.value } : x,
                        ),
                      )
                    }
                  />
                  <Button variant="ghost" onClick={() => setItems(items.filter((_, j) => j !== i))}>
                    移除
                  </Button>
                </div>
              ))}
              <TextInput
                placeholder="搜索款号或名称添加商品"
                value={pq}
                onChange={(e) => setPq(e.target.value)}
              />
              {prods.data?.rows
                .filter((p) => !items.some((i) => i.product.id === p.id))
                .map((p) => (
                  <div key={p.id} className="flex items-center justify-between py-1.5">
                    <span>
                      {p.styleNo} {p.name}
                    </span>
                    <Button
                      onClick={() => {
                        setItems([...items, { product: p, commissionPct: '' }]);
                        setPq('');
                      }}
                    >
                      添加
                    </Button>
                  </div>
                ))}
            </div>
          </>
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

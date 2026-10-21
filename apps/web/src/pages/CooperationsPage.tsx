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
  COOP_AUTO_STAGES,
  COOP_FOLLOW_STAGES,
  COOP_MAIN_STAGES,
  COOP_MODES,
  COOP_SIDE_STAGES,
  COOP_STAGES,
  PLATFORMS,
} from '@workbench/shared';
import { EntityList, type Col } from '../components/EntityList.tsx';
import {
  FollowDateInput,
  FollowUpDialog,
  QuickFollow,
  useDefaultFollowDate,
  useSettings,
} from '../components/FollowUp.tsx';
import { useAction } from '../components/detail.tsx';
import {
  Avatar,
  Badge,
  Button,
  Field,
  Modal,
  Select,
  TextInput,
  Textarea,
  cx,
} from '../components/ui.tsx';
import { api, qs } from '../lib/api.ts';
import { fmtDate, todayStr } from '../lib/format.ts';
import { CooperationDrawer } from './CooperationDrawer.tsx';
import { useStageChange } from '../components/useStageChange.tsx';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const pctText = (c: Row) =>
  c.productCount === 0
    ? '未选商品'
    : c.commissionMin == null
      ? '佣金未定'
      : `佣金 ${c.commissionMin === c.commissionMax ? c.commissionMin : `${c.commissionMin}–${c.commissionMax}`}%${c.commissionUnset ? '（部分未定）' : ''}`;

/** 下次跟进日期到了（只对待建联/洽谈中有意义，其他阶段的旧日期不算） */
const isDue = (c: Row, today: string) =>
  COOP_FOLLOW_STAGES.includes(c.stage) && !!c.nextFollowDate && c.nextFollowDate <= today;

const followLine = (c: Row) =>
  c.followCount === 0
    ? '还没有跟进'
    : `${c.followStatus ? `${c.followStatus} · ` : ''}第 ${c.followCount} 次 · ${c.daysSinceFollow === 0 ? '今天' : `${c.daysSinceFollow} 天前`}`;

/** 已确认之后的阶段才要求佣金定下来 */
const NEED_COMMISSION = new Set(['已确认', '待寄样', '已排期', '已开播', '待退样']);

/** 卡片底部的徽标，按优先级最多取 2 个：逾期 > 佣金未定 > 在外件数 > 缺开播日 */
function cardBadges(c: Row, today: string) {
  const out: { text: string; tone: 'red' | 'orange' | 'gray' | 'green' }[] = [];
  if (isDue(c, today)) {
    const days = Math.round(
      (Date.parse(today) - Date.parse(c.nextFollowDate as string)) / 86400_000,
    );
    out.push({ text: days > 0 ? `跟进逾期 ${days} 天` : '今天要跟进', tone: 'red' });
  }
  if (NEED_COMMISSION.has(c.stage) && (c.productCount === 0 || c.commissionUnset))
    out.push({ text: c.productCount === 0 ? '未选商品' : '佣金未定', tone: 'orange' });
  if (c.outstanding > 0) out.push({ text: `在外 ${c.outstanding} 件`, tone: 'gray' });
  if (c.stage === '已排期' && !c.liveDate) out.push({ text: '缺开播日', tone: 'orange' });
  if (c.stalled && c.stage === '洽谈中')
    out.push({ text: `连续 ${c.stallCount} 次待回复`, tone: 'orange' });
  return out.slice(0, 2);
}

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
            {view === 'board'
              ? '拖动卡片换阶段，点开看详情；悬停卡片可以直接记跟进'
              : '用表格看全部合作，可排序和筛选'}
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
  const settings = useSettings();
  const [q, setQ] = useState('');
  const [dueOnly, setDueOnly] = useState(false);
  const [platform, setPlatform] = useState('');
  const [followStatus, setFollowStatus] = useState('');
  const [openSide, setOpenSide] = useState<Set<string>>(new Set());
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
  const rows = all.filter(
    (c) =>
      (!dueOnly || isDue(c, today)) &&
      (!platform || c.platform === platform) &&
      (!followStatus || c.followStatus === followStatus),
  );
  const of = (stage: string) => rows.filter((c) => c.stage === stage);

  function onDragEnd(e: DragEndEvent) {
    const coop = all.find((c) => c.id === e.active.id);
    if (coop && e.over) request(coop, String(e.over.id));
  }

  const col = (stage: string) => (
    <Column
      key={stage}
      stage={stage}
      cards={of(stage)}
      today={today}
      onOpen={onOpen}
      onQuick={onQuick}
    />
  );
  const before = COOP_MAIN_STAGES.filter((s) => s === '待建联' || s === '洽谈中' || s === '已确认');
  const after = COOP_MAIN_STAGES.filter((s) => s === '待复盘' || s === '完成');

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
        <Select
          aria-label="平台"
          className="!w-32"
          value={platform}
          onChange={(e) => setPlatform(e.target.value)}
        >
          <option value="">全部平台</option>
          {PLATFORMS.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </Select>
        <Select
          aria-label="跟进状态"
          className="!w-36"
          value={followStatus}
          onChange={(e) => setFollowStatus(e.target.value)}
        >
          <option value="">全部跟进状态</option>
          {settings.data?.followStatuses.map((s) => (
            <option key={s.id}>{s.value}</option>
          ))}
        </Select>
        <label className="flex cursor-pointer items-center gap-2">
          <input type="checkbox" checked={dueOnly} onChange={(e) => setDueOnly(e.target.checked)} />
          只看今天及已逾期要跟进的
        </label>
      </div>
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        {/* 按看板自身宽度（而不是窗口宽度）决定阶段标签放左边还是上方 */}
        <div className="@container flex flex-col gap-2">
          {before.map(col)}
          <div className="flex flex-col gap-2 rounded-[30px] border-2 border-dashed border-line-strong p-1.5">
            <div className="px-3 pt-1 text-xs font-bold text-muted">
              执行中 · 由寄样和开播日自动推进，不用拖
            </div>
            {COOP_AUTO_STAGES.map(col)}
          </div>
          {after.map(col)}
          <div className="mt-2 flex flex-col gap-2">
            {COOP_SIDE_STAGES.map((s) => (
              <SideColumn
                key={s}
                stage={s}
                cards={of(s)}
                open={openSide.has(s)}
                onToggle={() => {
                  const next = new Set(openSide);
                  if (next.has(s)) next.delete(s);
                  else next.add(s);
                  setOpenSide(next);
                }}
                today={today}
                onOpen={onOpen}
                onQuick={onQuick}
              />
            ))}
          </div>
        </div>
      </DndContext>
      {dialog}
    </div>
  );
}

/** 泳道左侧（窄屏时在上方）的阶段标签：色点、阶段名、数量 */
function LaneLabel({ stage, count }: { stage: string; count: number }) {
  return (
    <span className="flex shrink-0 items-center gap-2 text-sm font-extrabold text-ink @xl:w-[132px]">
      <span
        aria-hidden="true"
        className="size-2.5 shrink-0 rounded-full"
        style={{ background: STAGE_DOT[stage] ?? '#8e88ff' }}
      />
      <span className="truncate">{stage}</span>
      <span className="min-w-6 rounded-full bg-surface px-2 text-center text-xs font-extrabold">
        {count}
      </span>
    </span>
  );
}

/** 卡片区：固定 260px 宽的卡片自动换行，不横向滚动 */
function LaneCards({
  cards,
  today,
  onOpen,
  onQuick,
}: {
  cards: Row[];
  today: string;
  onOpen: (id: string) => void;
  onQuick: (c: Row) => void;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-start gap-3">
      {cards.map((c) => (
        <div key={c.id} className="w-[260px] max-w-full">
          <CardView c={c} today={today} onOpen={onOpen} onQuick={onQuick} />
        </div>
      ))}
    </div>
  );
}

/** 一个阶段一行；整行可拖入，拖到哪一行就改到哪个阶段 */
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
  const auto = COOP_AUTO_STAGES.includes(stage);
  // 执行中的几行由系统推进，不接受拖入（抽屉里仍可手动改）
  const { setNodeRef, isOver } = useDroppable({ id: stage, disabled: auto });
  const empty = !cards.length;
  return (
    <section
      ref={setNodeRef}
      aria-label={empty ? `${stage}（空）` : stage}
      className={cx(
        'flex gap-2 rounded-3xl bg-[#e9e7f7] @xl:gap-3',
        // 空阶段始终是一条细行；有卡片时窄屏把标签放到卡片区上方
        empty ? 'min-h-11 items-center px-3 py-2' : 'flex-col p-3 @xl:flex-row @xl:items-start',
        isOver && 'outline-2 -outline-offset-2 outline-brand outline-dashed',
      )}
    >
      <h3 className={cx('m-0', !empty && '@xl:pt-1.5')}>
        <LaneLabel stage={stage} count={cards.length} />
      </h3>
      {empty ? (
        <div className="text-xs font-bold text-muted">
          {isOver ? '松手放到这里' : auto ? '暂无' : '拖到这里'}
        </div>
      ) : (
        <LaneCards cards={cards} today={today} onOpen={onOpen} onQuick={onQuick} />
      )}
    </section>
  );
}

/** 暂缓 / 流失 / 放弃：默认收起成一行（可以拖进来），点开看里面是谁 */
function SideColumn({
  stage,
  cards,
  open,
  onToggle,
  today,
  onOpen,
  onQuick,
}: {
  stage: string;
  cards: Row[];
  open: boolean;
  onToggle: () => void;
  today: string;
  onOpen: (id: string) => void;
  onQuick: (c: Row) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage });
  return (
    <section
      ref={setNodeRef}
      aria-label={stage}
      className={cx(
        'flex flex-col gap-2 rounded-3xl border-2 border-dashed px-3 py-2',
        isOver ? 'border-brand bg-brand-soft' : 'border-line-strong',
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={`${open ? '收起' : '展开'}${stage}（${cards.length}）`}
        className="flex min-h-7 cursor-pointer items-center gap-3 border-0 bg-transparent p-0 text-left text-muted"
      >
        <LaneLabel stage={stage} count={cards.length} />
        <span className="text-xs font-bold">
          {isOver ? '松手放到这里' : open ? '收起' : '展开'}
        </span>
      </button>
      {open &&
        (cards.length ? (
          <div className="pb-1">
            <LaneCards cards={cards} today={today} onOpen={onOpen} onQuick={onQuick} />
          </div>
        ) : (
          <div className="pb-1 text-xs font-bold text-muted">暂无，可以把卡片拖到这一行</div>
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
  const follow = COOP_FOLLOW_STAGES.includes(c.stage);
  const badges = cardBadges(c, today);
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
      className={cx(
        'group relative cursor-grab rounded-[20px] bg-surface p-4 text-[13px] shadow-[0_2px_0_var(--color-line-strong)]',
        isDragging && 'rotate-1 opacity-90 shadow-xl',
      )}
    >
      <QuickFollowButton c={c} onQuick={onQuick} />
      <div className="flex items-center gap-2.5 pr-8">
        <Avatar name={String(c.influencerNickname)} />
        <div className="min-w-0 flex-1">
          <b className="block truncate text-sm">{c.influencerNickname}</b>
          <span className="text-xs text-muted">
            {[c.platform, follow ? null : c.liveDate ? `开播 ${fmtDate(c.liveDate)}` : '档期待定']
              .filter(Boolean)
              .join(' · ')}
          </span>
        </div>
      </div>
      {follow && (
        <div className="mt-2.5 truncate rounded-xl bg-bg px-3 py-1.5 font-medium text-ink-2">
          {followLine(c)}
        </div>
      )}
      <div className="mt-2 truncate text-muted">
        {c.productCount > 0
          ? `${c.productNames.slice(0, 2).join('、')}${c.productCount > 2 ? ` 等 ${c.productCount} 款` : ''} · ${pctText(c)}`
          : pctText(c)}
      </div>
      {badges.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {badges.map((b) => (
            <Badge key={b.text} tone={b.tone}>
              {b.text}
            </Badge>
          ))}
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
        COOP_FOLLOW_STAGES.includes(r.stage)
          ? followLine(r)
          : r.followCount
            ? `${r.followCount} 次`
            : '',
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
  const defaultDate = useDefaultFollowDate();
  const [q, setQ] = useState('');
  const [inf, setInf] = useState<Row | null>(null);
  const [creatingInf, setCreatingInf] = useState(false);
  const [accountId, setAccountId] = useState('');
  const [contactId, setContactId] = useState('');
  const [mode, setMode] = useState<string>('纯佣');
  const [stage, setStage] = useState<string>('洽谈中');
  const [nextDate, setNextDate] = useState<string | null>(null);
  const [followStatus, setFollowStatus] = useState('');
  const [firstNote, setFirstNote] = useState('');
  const [liveDate, setLiveDate] = useState('');
  const [pq, setPq] = useState('');
  const [items, setItems] = useState<{ product: Row; commissionPct: string }[]>([]);
  const [err, setErr] = useState('');
  const date = nextDate ?? defaultDate;

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
    setAccountId(a?.length ? a[0].id : '');
    const primary = detail.data?.contacts.find((l: Row) => l.isPrimary);
    setContactId(primary?.contactId ?? '');
  }, [detail.data]);

  async function submit() {
    if (!inf) return setErr('请先选择或新建达人');
    if (!accountId) return setErr('这个达人还没有平台账号，先在上面添加一个');
    if (stage === '洽谈中' && (!date || date < todayStr()))
      return setErr('洽谈中的合作要有今天或之后的下次跟进日期');
    const pcts = items.map((i) => (i.commissionPct.trim() === '' ? null : Number(i.commissionPct)));
    if (pcts.some((p) => p !== null && (!Number.isFinite(p) || p < 0 || p > 100)))
      return setErr('佣金应为 0–100 的数字');
    setErr('');
    const negotiating = stage === '洽谈中';
    const res = await run(
      () =>
        api<{ row: Row }>('POST', '/cooperations', {
          cooperation: {
            influencerId: inf.id,
            platformAccountId: accountId,
            contactId: contactId || null,
            mode,
            stage,
            nextFollowDate: negotiating ? date : null,
            followStatus: negotiating ? followStatus || null : null,
            liveDate: liveDate || null,
          },
          products: items.map((i, idx) => ({ productId: i.product.id, commissionPct: pcts[idx] })),
        }),
      '合作已创建',
    );
    if (!res) return;
    // 首次沟通写成第一条跟进记录，卡片上就不会是"还没有跟进"
    if (firstNote.trim())
      await run(() =>
        api('POST', '/e/follow_up', {
          cooperationId: res.row.id,
          occurredAt: new Date().toISOString(),
          method: '微信',
          summary: firstNote.trim(),
          followStatus: negotiating ? followStatus || null : null,
          nextFollowDate: negotiating ? date : null,
        }),
      );
    onCreated(res.row.id);
  }

  return (
    <Modal
      title="新建合作"
      onClose={onClose}
      width={700}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={submit} disabled={!inf || creatingInf}>
            创建
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {creatingInf ? (
          <NewInfluencerInline
            initialName={q}
            onCancel={() => setCreatingInf(false)}
            onPicked={(r) => {
              setCreatingInf(false);
              setInf(r);
            }}
          />
        ) : !inf ? (
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
                className="flex cursor-pointer items-center gap-2.5 rounded-2xl border border-line bg-surface px-3 py-2 text-left hover:bg-bg"
                onClick={() => setInf(r)}
              >
                <Avatar name={String(r.nickname)} size={30} />
                <b>{r.nickname}</b>
                <span className="text-muted">
                  {r.accounts.map((a: Row) => `${a.platform}:${a.accountId}`).join('、') ||
                    '还没有账号'}
                </span>
              </button>
            ))}
            <Button variant="ghost" className="self-start" onClick={() => setCreatingInf(true)}>
              + 新建达人{q.trim() ? `「${q.trim()}」` : ''}
            </Button>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between rounded-2xl bg-bg px-4 py-2.5">
              <span className="flex items-center gap-2.5">
                <Avatar name={String(inf.nickname)} size={30} />
                <b>{inf.nickname}</b>
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
            {detail.data && !detail.data.accounts.length && (
              <AddAccountInline influencerId={inf.id} />
            )}
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
              <Field label="阶段">
                <Select value={stage} onChange={(e) => setStage(e.target.value)}>
                  {COOP_MAIN_STAGES.map((m) => (
                    <option key={m}>{m}</option>
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
            </div>
            {stage === '洽谈中' && (
              <div className="flex flex-col gap-3 rounded-2xl bg-bg px-4 py-3">
                <FollowDateInput required value={date} onChange={setNextDate} />
                <Field label="跟进状态">
                  <Select value={followStatus} onChange={(e) => setFollowStatus(e.target.value)}>
                    <option value="">—</option>
                    {settings.data?.followStatuses.map((s) => (
                      <option key={s.id}>{s.value}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="首次沟通（可选）" hint="会存成第一条跟进记录">
                  <Textarea
                    rows={2}
                    value={firstNote}
                    onChange={(e) => setFirstNote(e.target.value)}
                    placeholder="如：发了邀约，对方说看看档期"
                  />
                </Field>
              </div>
            )}
            <details className="rounded-2xl border border-line px-4 py-3">
              <summary className="cursor-pointer text-sm font-bold text-ink-2">
                开播日期和合作商品（可以之后在详情里补）
                {items.length ? ` · 已选 ${items.length} 款` : ''}
              </summary>
              <div className="mt-3 flex flex-col gap-3">
                <Field label="开播日期">
                  <TextInput
                    type="date"
                    className="!w-44"
                    value={liveDate}
                    onChange={(e) => setLiveDate(e.target.value)}
                  />
                </Field>
                <div>
                  <div className="mb-2 text-[13px] text-muted">
                    合作商品（每个商品可设不同佣金）
                  </div>
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
                      <Button
                        variant="ghost"
                        onClick={() => setItems(items.filter((_, j) => j !== i))}
                      >
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
              </div>
            </details>
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

/**
 * 在新建合作里顺手建达人 + 平台账号。先走查重：
 * 账号（平台 + 账号 ID）已存在就直接选中那位达人；昵称相似只提示，由用户决定（绝不自动合并）。
 */
function NewInfluencerInline({
  initialName,
  onCancel,
  onPicked,
}: {
  initialName: string;
  onCancel: () => void;
  onPicked: (inf: Row) => void;
}) {
  const run = useAction();
  const [nickname, setNickname] = useState(initialName.trim());
  const [platform, setPlatform] = useState<string>(PLATFORMS[0]);
  const [account, setAccount] = useState('');
  const [similar, setSimilar] = useState<Row[] | null>(null);
  const [err, setErr] = useState('');

  async function create(force: boolean) {
    if (!nickname.trim() || !account.trim()) return setErr('昵称和账号 ID 都要填');
    setErr('');
    const dup = await api<{ exact: Row | null; similar: { influencer: Row }[] }>(
      'GET',
      '/influencers/check-duplicate' +
        qs({ platform, accountId: account.trim(), nickname: nickname.trim() }),
    );
    if (dup.exact) {
      onPicked(dup.exact.influencer);
      return;
    }
    if (!force && dup.similar.length) {
      setSimilar(dup.similar.map((s) => s.influencer));
      return;
    }
    const res = await run(
      () =>
        api<{ influencer: Row }>('POST', '/influencers', {
          influencer: { nickname: nickname.trim() },
          accounts: [{ platform, accountId: account.trim() }],
        }),
      '达人已创建',
    );
    if (res) onPicked(res.influencer);
  }

  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-bg px-4 py-3">
      <div className="font-bold">新建达人</div>
      <div className="grid grid-cols-[1fr_120px_1fr] gap-2">
        <Field label="昵称 *">
          <TextInput value={nickname} onChange={(e) => setNickname(e.target.value)} autoFocus />
        </Field>
        <Field label="平台 *">
          <Select value={platform} onChange={(e) => setPlatform(e.target.value)}>
            {PLATFORMS.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </Select>
        </Field>
        <Field label="账号 ID *">
          <TextInput value={account} onChange={(e) => setAccount(e.target.value)} />
        </Field>
      </div>
      {similar && (
        <div className="flex flex-col gap-2 rounded-2xl bg-amber-soft px-4 py-3 text-[#8a4b00]">
          <span>有昵称相似的达人，是同一个人吗？</span>
          {similar.map((s) => (
            <Button key={s.id} className="self-start" onClick={() => onPicked(s)}>
              就是「{s.nickname}」，用这个
            </Button>
          ))}
          <Button variant="ghost" className="self-start" onClick={() => create(true)}>
            不是，仍然新建
          </Button>
        </div>
      )}
      {err && (
        <p className="m-0 text-warn" role="alert">
          {err}
        </p>
      )}
      <div className="flex gap-2">
        <Button variant="primary" onClick={() => create(false)}>
          创建并选中
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          返回搜索
        </Button>
      </div>
    </div>
  );
}

/** 选中的达人还没有平台账号时，就地补一个 */
function AddAccountInline({ influencerId }: { influencerId: string }) {
  const run = useAction();
  const [platform, setPlatform] = useState<string>(PLATFORMS[0]);
  const [account, setAccount] = useState('');
  return (
    <div className="flex flex-wrap items-end gap-2 rounded-2xl bg-amber-soft px-4 py-3">
      <span className="w-full text-sm font-bold text-[#8a4b00]">
        这个达人还没有平台账号，补一个才能建合作
      </span>
      <Select
        aria-label="平台"
        className="!w-28"
        value={platform}
        onChange={(e) => setPlatform(e.target.value)}
      >
        {PLATFORMS.map((p) => (
          <option key={p}>{p}</option>
        ))}
      </Select>
      <TextInput
        aria-label="账号 ID"
        className="!w-48"
        placeholder="账号 ID"
        value={account}
        onChange={(e) => setAccount(e.target.value)}
      />
      <Button
        variant="primary"
        disabled={!account.trim()}
        onClick={() =>
          run(
            () =>
              api('POST', '/e/platform_account', {
                influencerId,
                platform,
                accountId: account.trim(),
              }),
            '账号已添加',
          )
        }
      >
        添加
      </Button>
    </div>
  );
}

import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { motion } from 'motion/react';
import { useState } from 'react';
import { QuickEntry, SummaryCard } from '../components/ai/HomeAi.tsx';
import { FollowUpDialog, type FollowTarget } from '../components/FollowUp.tsx';
import { SamplesPanel } from '../components/samples.tsx';
import { Badge, Button, CountUp, Drawer, Empty } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { fmtDate } from '../lib/format.ts';
import { CooperationDrawer } from './CooperationDrawer.tsx';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const card = 'rounded-[28px] bg-surface px-6 py-5 shadow-[0_1px_0_var(--color-line)]';

const TONES = {
  indigo: 'bg-brand text-white',
  white: 'bg-surface text-ink shadow-[0_1px_0_var(--color-line)]',
  lime: 'bg-lime text-ink',
} as const;

function Stat({
  label,
  value,
  unit,
  note,
  warn,
  tone = 'white',
  index = 0,
}: {
  index?: number;
  label: string;
  value: number;
  unit?: string;
  note: React.ReactNode;
  warn?: boolean;
  tone?: keyof typeof TONES;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ y: -3 }}
      transition={{ duration: 0.3, delay: index * 0.06, ease: 'easeOut' }}
      className={`flex min-h-33 flex-col gap-1.5 rounded-[26px] p-5.5 ${TONES[tone]}`}
    >
      <div className={`text-sm font-medium ${tone === 'white' ? 'text-muted' : 'opacity-90'}`}>
        {label}
      </div>
      <div className="text-5xl font-extrabold leading-none tracking-tight">
        <CountUp value={value} />
        {unit && <span className="ml-1 text-xl font-bold text-muted">{unit}</span>}
      </div>
      <div
        className={`mt-auto inline-flex self-start rounded-full px-2.5 py-0.5 text-xs font-extrabold ${
          warn
            ? tone === 'white'
              ? 'bg-warn-soft text-warn'
              : 'bg-white text-warn'
            : tone === 'lime'
              ? 'text-ink'
              : tone === 'white'
                ? 'bg-bg text-muted'
                : 'bg-white/20 text-white'
        }`}
      >
        {note}
      </div>
    </motion.div>
  );
}

export function HomePage() {
  const q = useQuery({
    queryKey: ['home'],
    queryFn: () => api<Row>('GET', '/home'),
    staleTime: 15_000,
  });
  const [coopId, setCoopId] = useState<string | null>(null);
  const [inf, setInf] = useState<Row | null>(null);
  const [follow, setFollow] = useState<{ target: FollowTarget; coop?: Row } | null>(null);
  const d = q.data;

  if (q.isPending) return <Empty>加载中…</Empty>;
  if (q.isError || !d) return <Empty>首页数据加载失败：{(q.error as Error)?.message}</Empty>;
  const c = d.cards;

  return (
    <div className="flex flex-col gap-6">
      <header>
        <div className="text-sm font-medium text-muted">{fmtDate(d.today)}</div>
        <h1 className="m-0 mt-1 text-4xl font-extrabold leading-tight tracking-tight">
          {c.dueFollow.count ? (
            <>
              今天有 <span className="rounded-xl bg-lime px-2.5">{c.dueFollow.count} 项</span>{' '}
              待跟进
            </>
          ) : (
            '今天没有待跟进的事项'
          )}
        </h1>
      </header>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
        <Stat
          tone="indigo"
          index={0}
          label="今日待跟进"
          value={c.dueFollow.count}
          note={c.dueFollow.overdue ? `${c.dueFollow.overdue} 项已逾期` : '没有逾期'}
          warn={c.dueFollow.overdue > 0}
        />
        <Stat
          index={1}
          label="在外样品"
          value={c.samples.outstanding}
          unit="件"
          note={c.samples.overdueQty ? `${c.samples.overdueQty} 件逾期未寄回` : '没有逾期'}
          warn={c.samples.overdueQty > 0}
        />
        <Stat
          index={2}
          label="近 7 天开播"
          value={c.live7.count}
          unit="场"
          note={c.live7.unconfirmed ? `${c.live7.unconfirmed} 场佣金未确认` : '佣金都已确认'}
          warn={c.live7.unconfirmed > 0}
        />
        <Stat
          tone="lime"
          index={3}
          label="待审核改动"
          value={c.pendingReview}
          note={
            <Link to="/review" className="text-ink no-underline">
              去审核 →
            </Link>
          }
        />
      </div>

      <QuickEntry />

      <SummaryCard highlights={d.highlights} />

      <div className="flex flex-wrap items-start gap-6">
        <section aria-label="今日待跟进" className={`${card} min-w-0 flex-[3_1_520px]`}>
          <h2 className="m-0 mb-3 text-base">今日待跟进</h2>
          {d.dueFollows.length === 0 ? (
            <Empty>没有到期的跟进</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] border-collapse text-left">
                <thead>
                  <tr className="text-[13px] text-muted">
                    {['对象', '合作', '阶段', '应跟进', '下一步', ''].map((h) => (
                      <th key={h} className="px-2 py-2 font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {d.dueFollows.map((r: Row) => (
                    <tr key={`${r.kind}-${r.id}`} className="border-t border-line">
                      <td className="px-2 py-2.5 font-medium">
                        {r.kind === 'cooperation' ? (
                          <button
                            type="button"
                            className="cursor-pointer border-0 bg-transparent p-0 font-medium text-brand"
                            onClick={() => setCoopId(r.id)}
                          >
                            {r.name}
                          </button>
                        ) : (
                          <>
                            {r.name} <Badge>联系人</Badge>
                          </>
                        )}
                      </td>
                      <td className="px-2 py-2.5">{r.sub}</td>
                      <td className="px-2 py-2.5">{r.stage ?? '—'}</td>
                      <td
                        className={`whitespace-nowrap px-2 py-2.5 ${r.overdueDays > 0 ? 'text-warn' : ''}`}
                      >
                        {r.overdueDays > 0 ? `逾期 ${r.overdueDays} 天` : '今天'}
                      </td>
                      <td className="px-2 py-2.5">
                        {r.nextAction ?? <span className="text-muted">—</span>}
                      </td>
                      <td className="px-2 py-2.5 text-right">
                        <Button
                          onClick={() =>
                            setFollow(
                              r.kind === 'cooperation'
                                ? {
                                    target: { cooperationId: r.id },
                                    coop: { stage: r.stage, nextFollowDate: r.nextFollowDate },
                                  }
                                : { target: { contactId: r.id } },
                            )
                          }
                        >
                          记一笔
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section aria-label="寄样预警" className={`${card} min-w-0 flex-[2_1_340px]`}>
          <div className="flex items-baseline justify-between">
            <h2 className="m-0 mb-3 text-base">寄样预警</h2>
            <Link to="/samples" className="text-[13px]">
              全部在外样品
            </Link>
          </div>
          {d.sampleAlerts.length === 0 && <Empty>没有需要处理的样品</Empty>}
          {d.sampleAlerts.map((a: Row) => (
            <div key={a.influencerId} className="flex flex-col gap-2 border-t border-line py-2.5">
              <button
                type="button"
                className="w-fit cursor-pointer border-0 bg-transparent p-0 font-medium text-brand"
                onClick={() => setInf({ id: a.influencerId, nickname: a.nickname })}
              >
                {a.nickname}
              </button>
              {a.alerts.map((x: Row) => (
                <div key={x.type} className="flex items-center justify-between gap-3">
                  <span className="text-[13px] text-muted">{x.text}</span>
                  <span
                    className={`whitespace-nowrap rounded-xl px-2.5 py-0.5 text-[13px] ${x.tone === 'red' ? 'bg-orange-50 text-warn' : 'bg-bg text-ink-2'}`}
                  >
                    {x.badge}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </section>
      </div>

      <section aria-label="近 7 天开播" className={card}>
        <h2 className="m-0 mb-3 text-base">近 7 天待开播</h2>
        {d.upcomingLives.length === 0 ? (
          <Empty>近 7 天没有排期的直播</Empty>
        ) : (
          d.upcomingLives.map((l: Row) => (
            <div
              key={l.cooperationId}
              className="flex flex-wrap items-center justify-between gap-2 border-t border-line py-2.5"
            >
              <span>
                <button
                  type="button"
                  className="cursor-pointer border-0 bg-transparent p-0 font-medium text-brand"
                  onClick={() => setCoopId(l.cooperationId)}
                >
                  {l.influencerNickname}
                </button>{' '}
                <span className="text-muted">
                  {l.platform} · {l.stage}
                </span>
              </span>
              <span className="flex flex-wrap items-center gap-2">
                <b>{fmtDate(l.liveDate)}</b>{' '}
                {l.liveSlot && <span className="text-muted">{l.liveSlot}</span>}
                {l.commissionUnconfirmed && <Badge tone="orange">佣金未确认</Badge>}
                {l.linkMissing && <Badge tone="orange">挂链未确认</Badge>}
              </span>
            </div>
          ))
        )}
      </section>

      {coopId && <CooperationDrawer id={coopId} onClose={() => setCoopId(null)} />}
      {inf && (
        <Drawer title={`${inf.nickname} · 样品台账`} width={820} onClose={() => setInf(null)}>
          <SamplesPanel influencerId={inf.id} />
        </Drawer>
      )}
      {follow && (
        <FollowUpDialog target={follow.target} coop={follow.coop} onClose={() => setFollow(null)} />
      )}
    </div>
  );
}

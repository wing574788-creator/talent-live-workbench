import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { FOLLOW_METHODS, INTENTS } from '@workbench/shared';
import { api } from '../lib/api.ts';
import { fmtDateTime, todayStr } from '../lib/format.ts';
import { useAction } from './detail.tsx';
import { Badge, Button, Empty, Field, Modal, Select, TextInput, Textarea, cx } from './ui.tsx';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface Settings {
  followStatuses: { id: string; value: string }[];
  replyStallCount: number;
  defaultFollowDays: number;
  returnAfterLiveDays: number;
  returnAfterSignDays: number;
  shipOverdueDays: number;
  signedNotLiveDays: number;
}

export function useSettings() {
  return useQuery({ queryKey: ['settings'], queryFn: () => api<Settings>('GET', '/settings') });
}

const localNow = () => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

export interface FollowTarget {
  cooperationId?: string;
  influencerId?: string;
  contactId?: string;
}

/**
 * 记一笔跟进。关联合作时：跟进状态、下次跟进日期保存后同步到合作；
 * 合作在"洽谈中"且没有下次跟进日期时必须补上。
 */
export function FollowUpDialog({
  target,
  coop,
  onClose,
}: {
  target: FollowTarget;
  /** 关联合作时传入合作行，用来判断是否必须填下次跟进日期、预填当前跟进状态 */
  coop?: Row;
  onClose: () => void;
}) {
  const run = useAction();
  const settings = useSettings();
  const defaultDate = useDefaultFollowDate();
  // 洽谈中每记一笔都要定下一次（今天或之后），否则跟一次就断；其他阶段不需要跟进状态和日期
  const needDate = coop?.stage === '洽谈中';
  const showFollowFields = !coop || coop.stage === '待建联' || coop.stage === '洽谈中';
  const [f, setF] = useState({
    occurredAt: localNow(),
    method: '微信',
    summary: '',
    intent: '',
    followStatus: '',
    nextAction: '',
    nextFollowDate: coop?.stage === '洽谈中' ? defaultDate : '',
    sourceText: '',
  });
  const [err, setErr] = useState('');
  const set = (k: keyof typeof f, v: string) => setF({ ...f, [k]: v });

  async function submit() {
    if (!f.summary.trim()) return setErr('请填写内容摘要');
    if (needDate && !f.nextFollowDate)
      return setErr('洽谈中的合作需要填写下次跟进日期，避免跟一次就断掉');
    if (f.nextFollowDate && f.nextFollowDate < todayStr())
      return setErr('下次跟进日期不能早于今天');
    setErr('');
    const res = await run(
      () =>
        api('POST', '/e/follow_up', {
          ...target,
          occurredAt: new Date(f.occurredAt).toISOString(),
          method: f.method,
          summary: f.summary.trim(),
          intent: f.intent || null,
          followStatus: f.followStatus || null,
          nextAction: f.nextAction.trim() || null,
          nextFollowDate: f.nextFollowDate || null,
          sourceText: f.sourceText.trim() || null,
        }),
      '跟进已记录',
    );
    if (res) onClose();
  }

  return (
    <Modal
      title="记一笔跟进"
      onClose={onClose}
      width={600}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={submit}>
            保存
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-[120px_1fr] gap-3">
          <Field label="方式">
            <Select value={f.method} onChange={(e) => set('method', e.target.value)}>
              {FOLLOW_METHODS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </Select>
          </Field>
          <Field label="内容摘要 *">
            <Textarea
              rows={3}
              value={f.summary}
              onChange={(e) => set('summary', e.target.value)}
              placeholder="聊了什么、对方怎么说"
            />
          </Field>
        </div>
        {target.cooperationId && showFollowFields && (
          <Field label="跟进状态" hint="保存后同步到合作">
            <Select value={f.followStatus} onChange={(e) => set('followStatus', e.target.value)}>
              <option value="">—</option>
              {settings.data?.followStatuses.map((s) => (
                <option key={s.id}>{s.value}</option>
              ))}
            </Select>
          </Field>
        )}
        {showFollowFields && (
          <FollowDateInput
            required={needDate}
            value={f.nextFollowDate}
            onChange={(v) => set('nextFollowDate', v)}
          />
        )}
        <details className="rounded-2xl bg-bg px-4 py-3">
          <summary className="cursor-pointer text-sm font-bold text-ink-2">
            更多：时间、意向、下一步动作、原文出处
          </summary>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Field label="时间">
              <TextInput
                type="datetime-local"
                value={f.occurredAt}
                onChange={(e) => set('occurredAt', e.target.value)}
              />
            </Field>
            <Field label="意向">
              <Select value={f.intent} onChange={(e) => set('intent', e.target.value)}>
                <option value="">—</option>
                {INTENTS.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </Select>
            </Field>
            <div className="col-span-2">
              <Field label="下一步动作">
                <TextInput
                  value={f.nextAction}
                  onChange={(e) => set('nextAction', e.target.value)}
                  placeholder="如：发选款表"
                />
              </Field>
            </div>
            <div className="col-span-2">
              <Field label="原文出处（可选）">
                <Textarea
                  rows={2}
                  value={f.sourceText}
                  onChange={(e) => set('sourceText', e.target.value)}
                  placeholder="粘贴聊天原文，之后可在详情里核对"
                />
              </Field>
            </div>
          </div>
        </details>
      </div>
      {err && (
        <p className="mb-0 mt-3 text-warn" role="alert">
          {err}
        </p>
      )}
    </Modal>
  );
}

export function FollowTimeline({ items }: { items: Row[] }) {
  if (!items.length) return <Empty>还没有跟进记录</Empty>;
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {items.map((f) => (
        <li key={f.id} className="rounded-2xl bg-bg px-4 py-3">
          <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted">
            <span>{fmtDateTime(f.occurredAt)}</span>
            <Badge>{f.method}</Badge>
            {f.intent && <Badge tone={f.intent === '高' ? 'green' : 'gray'}>意向{f.intent}</Badge>}
            {f.followStatus && <Badge tone="green">{f.followStatus}</Badge>}
          </div>
          <div className="mt-1 whitespace-pre-wrap">{f.summary}</div>
          {(f.nextAction || f.nextFollowDate) && (
            <div className="mt-1 text-[13px] text-muted">
              下一步：{f.nextAction ?? ''} {f.nextFollowDate ? `· ${f.nextFollowDate}` : ''}
            </div>
          )}
          {f.sourceText && (
            <details className="mt-1 text-[13px] text-muted">
              <summary className="cursor-pointer">原文出处</summary>
              <div className="whitespace-pre-wrap">{f.sourceText}</div>
            </details>
          )}
        </li>
      ))}
    </ul>
  );
}

/** 今天（北京时间）往后 n 天的 YYYY-MM-DD */
export function plusDays(n: number): string {
  const d = new Date(`${todayStr()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 默认的下次跟进日期：今天 + 设置里的天数（默认 3） */
export function useDefaultFollowDate() {
  const settings = useSettings();
  return plusDays(settings.data?.defaultFollowDays ?? 3);
}

/** 下次跟进日期：日期框 + 明天 / 3 天后 / 下周 快捷按钮，不能早于今天 */
export function FollowDateInput({
  value,
  onChange,
  label = '下次跟进日期',
  required,
}: {
  value: string;
  onChange: (v: string) => void;
  label?: string;
  required?: boolean;
}) {
  const quick = [
    ['明天', 1],
    ['3 天后', 3],
    ['下周', 7],
  ] as const;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[13px] text-muted">{required ? `${label} *` : label}</span>
      <div className="flex flex-wrap items-center gap-1.5">
        <TextInput
          type="date"
          className="!w-40"
          min={todayStr()}
          aria-label={label}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        {quick.map(([t, n]) => {
          const v = plusDays(n);
          return (
            <button
              key={t}
              type="button"
              onClick={() => onChange(v)}
              className={cx(
                'min-h-8 cursor-pointer rounded-full border px-3 text-xs font-bold',
                value === v
                  ? 'border-transparent bg-brand-soft text-brand-dark'
                  : 'border-line bg-surface text-ink-2 hover:bg-bg',
              )}
            >
              {t}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 快速记跟进：一行摘要 + 跟进状态 + 下次跟进日期，回车保存。
 * 待建联/洽谈中的合作才有跟进状态和日期（洽谈中日期必填，默认预填今天 + N 天）；
 * 选了"暂无意向"时，保存后问一句要不要转暂缓。
 */
export function QuickFollow({
  target,
  coop,
  title,
  onClose,
  onExpand,
  onPause,
}: {
  target: FollowTarget;
  /** 关联合作时传入（至少要有 stage） */
  coop?: Row;
  title: string;
  onClose: () => void;
  /** 打开完整的跟进表单 */
  onExpand?: () => void;
  /** 选了"暂无意向"后，用户点"转为暂缓" */
  onPause?: () => void;
}) {
  const run = useAction();
  const settings = useSettings();
  const defaultDate = useDefaultFollowDate();
  const followStage = !coop || coop.stage === '待建联' || coop.stage === '洽谈中';
  const needDate = coop?.stage === '洽谈中';
  const [summary, setSummary] = useState('');
  const [method, setMethod] = useState('微信');
  const [status, setStatus] = useState('');
  const [date, setDate] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [askPause, setAskPause] = useState(false);
  // 没动过日期时：洽谈中用默认日期，其他不填
  const nextDate = date ?? (needDate ? defaultDate : '');

  async function submit() {
    if (!summary.trim()) return setErr('写一句聊了什么');
    if (needDate && !nextDate) return setErr('洽谈中的合作要定下次跟进日期');
    if (nextDate && nextDate < todayStr()) return setErr('下次跟进日期不能早于今天');
    setErr('');
    const res = await run(
      () =>
        api('POST', '/e/follow_up', {
          ...target,
          occurredAt: new Date().toISOString(),
          method,
          summary: summary.trim(),
          followStatus: (target.cooperationId && followStage && status) || null,
          nextFollowDate: (followStage && nextDate) || null,
        }),
      '跟进已记录',
    );
    if (!res) return;
    if (status === '暂无意向' && coop?.stage === '洽谈中' && onPause) setAskPause(true);
    else onClose();
  }

  if (askPause)
    return (
      <Modal
        title="对方暂无意向"
        onClose={onClose}
        width={420}
        footer={
          <>
            <Button onClick={onClose}>先不转</Button>
            <Button
              variant="primary"
              onClick={() => {
                onClose();
                onPause?.();
              }}
            >
              转为暂缓
            </Button>
          </>
        }
      >
        跟进已记录。要把这场合作转为「暂缓」吗？之后想重新谈，再改回洽谈中。
      </Modal>
    );

  return (
    <Modal
      title={`记跟进 · ${title}`}
      onClose={onClose}
      width={540}
      footer={
        <>
          {onExpand && (
            <Button
              variant="ghost"
              className="mr-auto"
              onClick={() => {
                onClose();
                onExpand();
              }}
            >
              完整表单…
            </Button>
          )}
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={submit}>
            保存
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="flex gap-2">
          <Select
            aria-label="方式"
            className="!w-24 shrink-0"
            value={method}
            onChange={(e) => setMethod(e.target.value)}
          >
            {FOLLOW_METHODS.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </Select>
          <TextInput
            autoFocus
            aria-label="聊了什么"
            placeholder="聊了什么，回车保存"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
          />
        </div>
        {target.cooperationId && followStage && (
          <div className="flex flex-col gap-1">
            <span className="text-[13px] text-muted">跟进状态</span>
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="跟进状态">
              {settings.data?.followStatuses.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="radio"
                  aria-checked={status === s.value}
                  onClick={() => setStatus(status === s.value ? '' : s.value)}
                  className={cx(
                    'min-h-8 cursor-pointer rounded-full border px-3 text-[13px]',
                    status === s.value
                      ? 'border-transparent bg-ink font-bold text-white'
                      : 'border-line bg-surface text-ink-2 hover:bg-bg',
                  )}
                >
                  {s.value}
                </button>
              ))}
            </div>
          </div>
        )}
        {followStage && <FollowDateInput required={needDate} value={nextDate} onChange={setDate} />}
        {err && (
          <p className="m-0 text-warn" role="alert">
            {err}
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

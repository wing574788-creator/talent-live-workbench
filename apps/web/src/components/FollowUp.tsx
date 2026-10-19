import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { FOLLOW_METHODS, INTENTS } from '@workbench/shared';
import { api } from '../lib/api.ts';
import { fmtDateTime } from '../lib/format.ts';
import { useAction } from './detail.tsx';
import { Badge, Button, Empty, Field, Modal, Select, TextInput, Textarea } from './ui.tsx';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface Settings {
  followStatuses: { id: string; value: string }[];
  replyStallCount: number;
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
  const needDate = coop?.stage === '洽谈中' && !coop?.nextFollowDate;
  const [f, setF] = useState({
    occurredAt: localNow(),
    method: '微信',
    summary: '',
    intent: '',
    followStatus: coop?.followStatus ?? '',
    nextAction: '',
    nextFollowDate: '',
    sourceText: '',
  });
  const [err, setErr] = useState('');
  const set = (k: keyof typeof f, v: string) => setF({ ...f, [k]: v });

  async function submit() {
    if (!f.summary.trim()) return setErr('请填写内容摘要');
    if (needDate && !f.nextFollowDate)
      return setErr('洽谈中的合作需要填写下次跟进日期，避免跟一次就断掉');
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
      <div className="grid grid-cols-2 gap-3">
        <Field label="时间">
          <TextInput
            type="datetime-local"
            value={f.occurredAt}
            onChange={(e) => set('occurredAt', e.target.value)}
          />
        </Field>
        <Field label="方式">
          <Select value={f.method} onChange={(e) => set('method', e.target.value)}>
            {FOLLOW_METHODS.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </Select>
        </Field>
        <div className="col-span-2">
          <Field label="内容摘要 *">
            <Textarea
              rows={3}
              value={f.summary}
              onChange={(e) => set('summary', e.target.value)}
              placeholder="聊了什么、对方怎么说"
            />
          </Field>
        </div>
        <Field label="意向">
          <Select value={f.intent} onChange={(e) => set('intent', e.target.value)}>
            <option value="">—</option>
            {INTENTS.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </Select>
        </Field>
        {target.cooperationId && (
          <Field label="跟进状态" hint="保存后同步到合作">
            <Select value={f.followStatus} onChange={(e) => set('followStatus', e.target.value)}>
              <option value="">—</option>
              {settings.data?.followStatuses.map((s) => (
                <option key={s.id}>{s.value}</option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="下一步动作">
          <TextInput
            value={f.nextAction}
            onChange={(e) => set('nextAction', e.target.value)}
            placeholder="如：发选款表"
          />
        </Field>
        <Field
          label={needDate ? '下次跟进日期 *' : '下次跟进日期'}
          hint={target.cooperationId ? '保存后同步到合作' : undefined}
        >
          <TextInput
            type="date"
            value={f.nextFollowDate}
            onChange={(e) => set('nextFollowDate', e.target.value)}
          />
        </Field>
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

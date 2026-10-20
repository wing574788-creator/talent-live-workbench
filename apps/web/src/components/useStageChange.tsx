import { useState } from 'react';
import { useSettings } from './FollowUp.tsx';
import { patchEntity, useAction } from './detail.tsx';
import { todayStr } from '../lib/format.ts';
import { Button, Field, Modal, Select, TextInput, Textarea } from './ui.tsx';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// ───────────── 阶段变更（带必填项） ─────────────
export function useStageChange() {
  const run = useAction();
  const settings = useSettings();
  const [pending, setPending] = useState<{ coop: Row; target: string } | null>(null);
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  const [status, setStatus] = useState('');

  const commit = (coop: Row, patch: Record<string, unknown>) =>
    run(() => patchEntity('cooperation', coop.id, patch, coop.version), `已改为「${patch.stage}」`);

  function request(coop: Row, target: string) {
    if (coop.stage === target) return;
    // 已过期的下次跟进日期不算数；进入流失/放弃一律重新填写原因（离开时服务端会清掉旧原因）
    const needDate =
      target === '洽谈中' && (!coop.nextFollowDate || coop.nextFollowDate < todayStr());
    const lost = (s: string) => s === '流失' || s === '放弃';
    const needReason = lost(target) && !(lost(coop.stage) && coop.lostReason);
    if (needDate || needReason) {
      setDate('');
      setReason('');
      setStatus('');
      setPending({ coop, target });
    } else commit(coop, { stage: target });
  }

  const dialog = pending && (
    <Modal
      title={`改为「${pending.target}」`}
      onClose={() => setPending(null)}
      width={460}
      footer={
        <>
          <Button onClick={() => setPending(null)}>取消</Button>
          <Button
            variant="primary"
            onClick={async () => {
              const t = pending.target;
              const patch: Record<string, unknown> = { stage: t };
              if (t === '洽谈中') {
                if (!date || date < todayStr()) return;
                patch.nextFollowDate = date;
                if (status) patch.followStatus = status;
              }
              if (t === '流失' || t === '放弃') {
                if (!reason.trim()) return;
                patch.lostReason = reason.trim();
              }
              if (await commit(pending.coop, patch)) setPending(null);
            }}
          >
            确认
          </Button>
        </>
      }
    >
      {pending.target === '洽谈中' ? (
        <div className="flex flex-col gap-3">
          <p className="m-0 text-muted">洽谈中的合作必须有下次跟进日期。</p>
          <Field label="下次跟进日期 *">
            <TextInput
              type="date"
              min={todayStr()}
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </Field>
          <Field label="跟进状态">
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">—</option>
              {settings.data?.followStatuses.map((s) => (
                <option key={s.id}>{s.value}</option>
              ))}
            </Select>
          </Field>
        </div>
      ) : (
        <Field label={`${pending.target}原因 *`}>
          <Textarea
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="如：对方暂无档期、佣金谈不拢"
          />
        </Field>
      )}
    </Modal>
  );
  return { request, dialog };
}

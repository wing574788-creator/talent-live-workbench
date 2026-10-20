import { useQuery } from '@tanstack/react-query';
import { PageHeader } from '../components/ui.tsx';
import { useState } from 'react';
import { CUSTOM_FIELD_ENTITIES, CUSTOM_FIELD_TYPES } from '@workbench/shared';
import { ModelsCard, OutboundCard, OutboundLogCard } from '../components/ai/AiSettings.tsx';
import { BackupCard } from '../components/BackupCard.tsx';
import { ChangeLogPanel } from '../components/ChangeLog.tsx';
import { TemplatesCard } from '../components/import/Templates.tsx';
import { useSettings } from '../components/FollowUp.tsx';
import { useAction } from '../components/detail.tsx';
import { Badge, Button, Card, Empty, Field, Select, TextInput } from '../components/ui.tsx';
import { api } from '../lib/api.ts';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const ENTITY_LABEL: Record<string, string> = {
  product: '商品',
  influencer: '达人',
  contact: '联系人',
  cooperation: '合作',
};
const TYPE_LABEL: Record<string, string> = {
  text: '文本',
  number: '数字',
  date: '日期',
  select: '单选',
  multiselect: '多选',
  bool: '是/否',
};

export function SettingsPage() {
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="设置" hint="模型、外发规则、预警天数、备份和自定义字段" />
      <FollowStatuses />
      <SampleDays />
      <ModelsCard />
      <OutboundCard />
      <OutboundLogCard />
      <TemplatesCard />
      <BackupCard />
      <ChangeLogPanel />
      <CustomFields />
    </div>
  );
}

function CustomFields() {
  const run = useAction();
  const [entity, setEntity] = useState<string>('product');
  const [form, setForm] = useState({
    key: '',
    label: '',
    type: 'text',
    options: '',
    sensitive: false,
    indexed: false,
  });
  const defs = useQuery({
    queryKey: ['field_defs', entity],
    queryFn: () => api<{ rows: Row[] }>('GET', `/e/field_def?f.entity=${entity}`),
  });
  const needsOptions = form.type === 'select' || form.type === 'multiselect';
  return (
    <Card title="自定义字段">
      <div className="mb-4 flex gap-2">
        {CUSTOM_FIELD_ENTITIES.map((e) => (
          <Button
            key={e}
            variant={e === entity ? 'primary' : 'secondary'}
            onClick={() => setEntity(e)}
          >
            {ENTITY_LABEL[e]}
          </Button>
        ))}
      </div>
      {defs.data?.rows.length === 0 && <Empty>「{ENTITY_LABEL[entity]}」还没有自定义字段</Empty>}
      {defs.data?.rows.map((d) => (
        <div
          key={d.id}
          className="flex items-center justify-between gap-2 border-b border-line py-2 last:border-0"
        >
          <span>
            <b>{d.label}</b> <span className="text-muted">{d.key}</span>{' '}
            <Badge>{TYPE_LABEL[d.type]}</Badge>
            {d.options && <span className="text-muted"> {d.options.join('、')}</span>}
            {d.sensitive && <Badge tone="orange">敏感</Badge>}
          </span>
          <Button
            variant="ghost"
            onClick={() => run(() => api('DELETE', `/e/field_def/${d.id}`), '字段已删除')}
          >
            删除
          </Button>
        </div>
      ))}
      <h4 className="mb-3 mt-6 text-base font-extrabold">新增字段</h4>
      <div className="grid grid-cols-4 items-start gap-3">
        <Field label="字段键" hint="小写字母、数字、下划线">
          <TextInput
            value={form.key}
            onChange={(e) => setForm({ ...form, key: e.target.value })}
            placeholder="season"
          />
        </Field>
        <Field label="显示名称">
          <TextInput
            value={form.label}
            onChange={(e) => setForm({ ...form, label: e.target.value })}
            placeholder="季节"
          />
        </Field>
        <Field label="类型">
          <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
            {CUSTOM_FIELD_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </Select>
        </Field>
        {needsOptions && (
          <Field label="选项（逗号分隔）">
            <TextInput
              value={form.options}
              onChange={(e) => setForm({ ...form, options: e.target.value })}
              placeholder="春，夏，秋，冬"
            />
          </Field>
        )}
      </div>
      <label className="mt-3 flex items-center gap-2">
        <input
          type="checkbox"
          checked={form.sensitive}
          onChange={(e) => setForm({ ...form, sensitive: e.target.checked })}
        />
        敏感字段（外发时脱敏）
      </label>
      <div className="mt-3">
        <Button
          variant="primary"
          onClick={async () => {
            const options = needsOptions ? form.options.split(/[,，、\s]+/).filter(Boolean) : null;
            if (
              await run(
                () =>
                  api('POST', '/e/field_def', {
                    entity,
                    key: form.key,
                    label: form.label,
                    type: form.type,
                    options,
                    sensitive: form.sensitive,
                  }),
                '字段已添加',
              )
            ) {
              setForm({
                key: '',
                label: '',
                type: 'text',
                options: '',
                sensitive: false,
                indexed: false,
              });
            }
          }}
        >
          添加字段
        </Button>
      </div>
      <p className="mb-0 mt-3 text-muted">
        添加后，该字段会出现在对应列表的「列」菜单里，并出现在新建和编辑表单中；单选字段可作为列表筛选条件。
      </p>
    </Card>
  );
}

function FollowStatuses() {
  const run = useAction();
  const settings = useSettings();
  const [value, setValue] = useState('');
  const [n, setN] = useState('');
  const statuses = settings.data?.followStatuses ?? [];
  return (
    <Card title="洽谈中的跟进状态">
      <p className="mt-0 text-muted">记跟进时可选的状态；删除选项不会影响已经用了它的合作。</p>
      <div className="flex flex-wrap gap-2">
        {statuses.map((s) => (
          <span key={s.id} className="inline-flex items-center gap-1 rounded-full bg-bg px-3 py-1">
            {s.value}
            <button
              type="button"
              aria-label={`删除 ${s.value}`}
              className="cursor-pointer border-0 bg-transparent text-warn"
              onClick={() => run(() => api('DELETE', `/e/enum_option/${s.id}`))}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <TextInput
          className="!w-48"
          placeholder="新状态，如 已看样"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <Button
          variant="primary"
          onClick={async () => {
            if (
              await run(
                () =>
                  api('POST', '/e/enum_option', {
                    group: 'follow_status',
                    value,
                    sortOrder: statuses.length,
                  }),
                '已添加',
              )
            )
              setValue('');
          }}
        >
          添加
        </Button>
      </div>
      <h4 className="mb-2 mt-5">连续待回复提醒</h4>
      <div className="flex items-center gap-2">
        连续
        <TextInput
          className="!w-20"
          inputMode="numeric"
          placeholder={String(settings.data?.replyStallCount ?? 3)}
          value={n}
          onChange={(e) => setN(e.target.value)}
        />
        次跟进状态都是「待回复」时，提醒转暂缓或流失（当前 {settings.data?.replyStallCount ?? 3}{' '}
        次）
        <Button
          onClick={async () => {
            if (
              await run(
                () => api('PUT', '/settings/replyStallCount', { value: Number(n) }),
                '已保存',
              )
            )
              setN('');
          }}
        >
          保存
        </Button>
      </div>
      <DefaultFollowDays />
    </Card>
  );
}

/** 记跟进、进入洽谈中时下次跟进日期的默认值 */
function DefaultFollowDays() {
  const run = useAction();
  const settings = useSettings();
  const [n, setN] = useState('');
  const current = settings.data?.defaultFollowDays ?? 3;
  return (
    <>
      <h4 className="mb-2 mt-5">默认下次跟进</h4>
      <div className="flex items-center gap-2">
        记跟进时，下次跟进日期默认预填今天 +
        <TextInput
          className="!w-20"
          inputMode="numeric"
          aria-label="默认下次跟进天数"
          placeholder={String(current)}
          value={n}
          onChange={(e) => setN(e.target.value)}
        />
        天（当前 {current} 天）
        <Button
          disabled={n === ''}
          onClick={async () => {
            if (
              await run(
                () => api('PUT', '/settings/defaultFollowDays', { value: Number(n) }),
                '已保存',
              )
            )
              setN('');
          }}
        >
          保存
        </Button>
      </div>
    </>
  );
}

const SAMPLE_DAY_FIELDS = [
  { key: 'returnAfterLiveDays', label: '有开播日：开播日 + N 天应寄回', suffix: '天（N）' },
  { key: 'returnAfterSignDays', label: '没有开播日：签收日 + M 天应寄回', suffix: '天（M）' },
  { key: 'shipOverdueDays', label: '待寄样超过多少天未寄出就预警', suffix: '天' },
  { key: 'signedNotLiveDays', label: '已签收超过多少天未开播就预警', suffix: '天' },
] as const;

function SampleDays() {
  const run = useAction();
  const settings = useSettings();
  const [draft, setDraft] = useState<Record<string, string>>({});
  return (
    <Card title="样品寄回日期">
      <p className="mt-0 text-muted">
        寄出或签收时，系统按这里的天数自动填应寄回日期；只对之后新寄出、新签收的寄样单生效，已经填好的不会变。每张寄样单的应寄回日期也可以在寄出时手动指定，或之后用「延期」修改。
      </p>
      <div className="flex flex-col gap-3">
        {SAMPLE_DAY_FIELDS.map((f) => {
          const current = settings.data?.[f.key];
          const value = draft[f.key] ?? '';
          return (
            <div key={f.key} className="flex flex-wrap items-center gap-2">
              <span className="w-72">{f.label}</span>
              <TextInput
                className="!w-20"
                inputMode="numeric"
                aria-label={f.label}
                placeholder={String(current ?? '')}
                value={value}
                onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
              />
              <span className="text-muted">
                {f.suffix}，当前 {current ?? '—'}
              </span>
              <Button
                disabled={value === ''}
                onClick={async () => {
                  const res = await run(
                    () => api('PUT', `/settings/${f.key}`, { value: Number(value) }),
                    '已保存',
                  );
                  if (res) setDraft({ ...draft, [f.key]: '' });
                }}
              >
                保存
              </Button>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

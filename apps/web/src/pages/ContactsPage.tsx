import { useState } from 'react';
import { PageHeader } from '../components/ui.tsx';
import { useRegisterSelection } from '../lib/selection.ts';
import { CONTACT_TYPES } from '@workbench/shared';
import { FollowUpDialog } from '../components/FollowUp.tsx';
import { EntityList, type Col } from '../components/EntityList.tsx';
import {
  EditableFields,
  FormGrid,
  fromForm,
  toForm,
  type FieldSpec,
} from '../components/FormFields.tsx';
import {
  HistoryList,
  Section,
  patchEntity,
  useAction,
  useDetail,
  useReveal,
} from '../components/detail.tsx';
import {
  Avatar,
  Badge,
  Button,
  ConfirmDialog,
  Drawer,
  Empty,
  Modal,
  Tabs,
} from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { fmtDateTime } from '../lib/format.ts';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const SPECS: FieldSpec[] = [
  { key: 'name', label: '姓名', type: 'text', required: true },
  { key: 'type', label: '类型', type: 'select', options: [...CONTACT_TYPES], required: true },
  { key: 'org', label: '所属机构', type: 'text' },
  { key: 'wechat', label: '微信', type: 'text', sensitive: true },
  { key: 'phone', label: '手机', type: 'text', sensitive: true },
  { key: 'nextFollowDate', label: '下次跟进日期', type: 'date' },
];

const COLS: Col<Row>[] = [
  {
    id: 'name',
    header: '姓名',
    sort: 'name',
    cell: (r) => (
      <span className="flex items-center gap-3">
        <Avatar name={String(r.name)} />
        <b className="text-[15px]">{r.name}</b>
      </span>
    ),
  },
  {
    id: 'type',
    header: '类型',
    sort: 'type',
    cell: (r) => (
      <Badge tone={r.type === 'MCN' || r.type === '经纪人' ? 'green' : 'gray'}>{r.type}</Badge>
    ),
  },
  { id: 'org', header: '所属机构', sort: 'org', cell: (r) => r.org ?? '' },
  { id: 'wechat', header: '微信', cell: (r) => r.wechat ?? '' },
  { id: 'phone', header: '手机', cell: (r) => r.phone ?? '' },
];

export function ContactsPage() {
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="联系人"
        hint="达人本人、MCN、经纪人、私人商务；微信和手机默认打码，点开才显示"
      />
      <EntityList
        entity="contact"
        endpoint="/contacts"
        cols={COLS}
        filters={[{ key: 'type', label: '类型', options: [...CONTACT_TYPES] }]}
        searchPlaceholder="搜索姓名、机构"
        onOpen={setOpenId}
        headerActions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            新建联系人
          </Button>
        }
      />
      {creating && (
        <NewContact
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setOpenId(id);
          }}
        />
      )}
      {openId && <ContactDrawer id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function NewContact({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const run = useAction();
  const [form, setForm] = useState(() => toForm({ type: '经纪人' }, SPECS));
  const [err, setErr] = useState('');
  return (
    <Modal
      title="新建联系人"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            onClick={async () => {
              try {
                const payload = fromForm(form, SPECS);
                setErr('');
                const res = await run(() => api('POST', '/e/contact', payload), '联系人已创建');
                if (res) onCreated(res.row.id);
              } catch (e) {
                setErr((e as Error).message);
              }
            }}
          >
            创建
          </Button>
        </>
      }
    >
      <FormGrid specs={SPECS} form={form} setForm={setForm} />
      {err && <p className="mb-0 mt-3 text-warn">{err}</p>}
    </Modal>
  );
}

export function ContactDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  useRegisterSelection('contact', id);
  const run = useAction();
  const q = useDetail<Row>('contact', '/contacts', id);
  const reveal = useReveal(`/contacts/${id}/reveal`);
  const [tab, setTab] = useState('基本信息');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [follow, setFollow] = useState(false);
  const d = q.data;
  const c = d?.contact;
  const revealed = !!reveal.data;
  return (
    <Drawer title={c ? c.name : '联系人'} onClose={onClose}>
      {q.isPending && <Empty>加载中…</Empty>}
      {q.isError && <Empty>{(q.error as Error).message}</Empty>}
      {d && c && (
        <div className="flex flex-col gap-4">
          <div className="flex justify-end">
            <Button onClick={reveal.toggle}>{revealed ? '隐藏敏感信息' : '查看敏感信息'}</Button>
          </div>
          <Tabs
            tabs={['基本信息', '管辖的达人', '沟通记录', '变更历史']}
            value={tab}
            onChange={setTab}
          />
          {tab === '基本信息' && (
            <Section title="基本信息">
              <EditableFields
                specs={SPECS}
                row={revealed ? { ...c, ...reveal.data } : c}
                locked={revealed ? undefined : new Set(['wechat', 'phone'])}
                onSave={async (patch) => {
                  if (!(await run(() => patchEntity('contact', c.id, patch, c.version), '已保存')))
                    throw new Error('保存失败，详见提示');
                }}
                extra={
                  <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                    删除联系人
                  </Button>
                }
              />
            </Section>
          )}
          {tab === '管辖的达人' && (
            <Section title={`管辖的达人（${d.influencers.length}）`}>
              {d.influencers.length === 0 ? (
                <Empty>还没有关联达人，在达人详情的「联系人」里关联</Empty>
              ) : (
                d.influencers.map((l: Row) => (
                  <div key={l.id} className="border-b border-line py-2 last:border-0">
                    {l.influencer.nickname} {l.isPrimary && <Badge tone="green">主要对接人</Badge>}
                  </div>
                ))
              )}
            </Section>
          )}
          {tab === '沟通记录' && (
            <Section
              title="沟通记录"
              actions={
                <Button variant="primary" onClick={() => setFollow(true)}>
                  记一笔跟进
                </Button>
              }
            >
              {d.followUps.length === 0 ? (
                <Empty>还没有跟进记录</Empty>
              ) : (
                d.followUps.map((f: Row) => (
                  <div key={f.id} className="border-b border-line py-2 last:border-0">
                    <span className="text-muted">
                      {fmtDateTime(f.occurredAt)} · {f.method}
                    </span>
                    <div>{f.summary}</div>
                  </div>
                ))
              )}
            </Section>
          )}
          {tab === '变更历史' && <HistoryList logs={d.history} />}
        </div>
      )}
      {follow && c && (
        <FollowUpDialog target={{ contactId: c.id }} onClose={() => setFollow(false)} />
      )}
      {confirmDelete && c && (
        <ConfirmDialog
          title="删除联系人"
          danger
          confirmLabel="删除"
          message={`确定删除「${c.name}」？其微信、手机号会一并删除；可在变更历史里撤销。`}
          onClose={() => setConfirmDelete(false)}
          onConfirm={async () => {
            if (
              await run(
                () => api('DELETE', `/e/contact/${c.id}?expectedVersion=${c.version}`),
                '已删除',
              )
            )
              onClose();
          }}
        />
      )}
    </Drawer>
  );
}

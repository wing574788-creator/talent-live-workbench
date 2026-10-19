import { useQuery } from '@tanstack/react-query';
import { useRegisterSelection } from '../lib/selection.ts';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { ACCOUNT_ROLES, CONTACT_TYPES, PLATFORMS } from '@workbench/shared';
import { SamplesPanel } from '../components/samples.tsx';
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
  Badge,
  Button,
  ConfirmDialog,
  Drawer,
  Empty,
  Field,
  Modal,
  Select,
  Tabs,
  TextInput,
} from '../components/ui.tsx';
import { api, qs } from '../lib/api.ts';
import { fmtDate, fmtDateTime, fmtMoney } from '../lib/format.ts';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const SPECS: FieldSpec[] = [
  { key: 'nickname', label: '昵称', type: 'text', required: true },
  { key: 'realName', label: '真实姓名', type: 'text', sensitive: true },
  { key: 'categoryTags', label: '类目标签', type: 'tags' },
  { key: 'styleTags', label: '风格标签', type: 'tags' },
  { key: 'coopPreference', label: '合作方式偏好', type: 'text' },
  { key: 'refCommissionPct', label: '参考佣金（%）', type: 'percent' },
  { key: 'refQuoteCents', label: '参考报价', type: 'money' },
  { key: 'refSource', label: '参考数据来源', type: 'text' },
  { key: 'rating', label: '评级', type: 'text' },
  { key: 'blacklistReason', label: '黑名单原因', type: 'text', wide: true },
];

const ACCOUNT_SPECS: FieldSpec[] = [
  { key: 'platform', label: '平台', type: 'select', options: [...PLATFORMS], required: true },
  { key: 'accountId', label: '账号 ID', type: 'text', required: true },
  { key: 'profileUrl', label: '主页链接', type: 'text', wide: true },
  { key: 'role', label: '身份', type: 'select', options: [...ACCOUNT_ROLES] },
  { key: 'followers', label: '粉丝数', type: 'number' },
  { key: 'avgViews', label: '场均观看', type: 'number' },
  { key: 'avgSalesMinCents', label: '场均销售额下限', type: 'money' },
  { key: 'avgSalesMaxCents', label: '场均销售额上限', type: 'money' },
  { key: 'statsDate', label: '数据日期', type: 'date' },
];

const isStale = (d?: string | null) => !!d && Date.now() - new Date(d).getTime() > 90 * 86400_000;

const COLS: Col<Row>[] = [
  { id: 'nickname', header: '昵称', sort: 'nickname', cell: (r) => <b>{r.nickname}</b> },
  {
    id: 'accounts',
    header: '平台账号',
    cell: (r) => (
      <div className="flex flex-col gap-0.5">
        {r.accounts.map((a: Row) => (
          <span key={a.id}>
            <Badge>{a.platform}</Badge> {a.accountId}
          </span>
        ))}
      </div>
    ),
  },
  { id: 'tags', header: '类目', cell: (r) => (r.categoryTags ?? []).join('、') },
  { id: 'rating', header: '评级', sort: 'rating', cell: (r) => r.rating ?? '' },
  { id: 'coopCount', header: '合作次数', cell: (r) => r.coopCount },
  {
    id: 'recycle',
    header: '回收问题',
    sort: 'recycleIssueCount',
    cell: (r) =>
      r.recycleIssueCount ? <Badge tone="orange">{r.recycleIssueCount} 次</Badge> : '0',
  },
  { id: 'realName', header: '真实姓名', defaultHidden: true, cell: (r) => r.realName ?? '' },
  {
    id: 'updatedAt',
    header: '更新时间',
    sort: 'updatedAt',
    defaultHidden: true,
    cell: (r) => fmtDate(r.updatedAt),
  },
];

export function InfluencersPage() {
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [platform, setPlatform] = useState('');
  return (
    <div className="flex flex-col gap-5">
      <h1 className="m-0 text-2xl font-bold">达人</h1>
      <EntityList
        entity="influencer"
        endpoint="/influencers"
        cols={COLS}
        searchPlaceholder="搜索昵称、账号 ID"
        extraParams={{ platform: platform || undefined }}
        onOpen={setOpenId}
        headerActions={
          <>
            <Select
              aria-label="平台"
              className="!w-auto"
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
            >
              <option value="">平台：全部</option>
              {PLATFORMS.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </Select>
            <Button variant="primary" onClick={() => setCreating(true)}>
              新建达人
            </Button>
          </>
        }
      />
      {creating && (
        <NewInfluencer
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setOpenId(id);
          }}
          onOpenExisting={(id) => {
            setCreating(false);
            setOpenId(id);
          }}
        />
      )}
      {openId && (
        <InfluencerDrawer id={openId} onClose={() => setOpenId(null)} onSwitch={setOpenId} />
      )}
    </div>
  );
}

function NewInfluencer({
  onClose,
  onCreated,
  onOpenExisting,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
  onOpenExisting: (id: string) => void;
}) {
  const run = useAction();
  const [form, setForm] = useState(() => toForm({}, SPECS));
  const [acc, setAcc] = useState(() => toForm({ platform: PLATFORMS[0] }, ACCOUNT_SPECS));
  const [err, setErr] = useState('');
  const [probe, setProbe] = useState({ nickname: '', platform: '', accountId: '' });
  useEffect(() => {
    const t = setTimeout(
      () =>
        setProbe({
          nickname: form.nickname ?? '',
          platform: acc.platform ?? '',
          accountId: acc.accountId ?? '',
        }),
      300,
    );
    return () => clearTimeout(t);
  }, [form.nickname, acc.platform, acc.accountId]);
  const dup = useQuery({
    queryKey: ['dup', probe],
    enabled: !!(probe.nickname.trim() || probe.accountId.trim()),
    queryFn: () =>
      api<{ exact: Row | null; similar: Row[] }>('GET', '/influencers/check-duplicate' + qs(probe)),
  });
  const exact = dup.data?.exact;
  return (
    <Modal
      title="新建达人"
      onClose={onClose}
      width={720}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            disabled={!!exact}
            onClick={async () => {
              try {
                const influencer = fromForm(form, SPECS);
                const accounts = acc.accountId?.trim() ? [fromForm(acc, ACCOUNT_SPECS)] : [];
                setErr('');
                const res = await run(
                  () => api('POST', '/influencers', { influencer, accounts }),
                  '达人已创建',
                );
                if (res) onCreated(res.influencer.id);
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
      <FormGrid
        specs={SPECS.filter((s) =>
          ['nickname', 'realName', 'categoryTags', 'styleTags'].includes(s.key),
        )}
        form={form}
        setForm={setForm}
      />
      <h4 className="mb-2 mt-5">平台账号（可稍后在详情里补充）</h4>
      <FormGrid
        specs={ACCOUNT_SPECS.filter((s) =>
          ['platform', 'accountId', 'profileUrl', 'role', 'followers'].includes(s.key),
        )}
        form={acc}
        setForm={setAcc}
      />
      {exact && (
        <div
          className="mt-4 rounded-lg border border-warn bg-orange-50 px-3 py-2 text-warn"
          role="alert"
        >
          该平台账号已存在：{exact.influencer.nickname}。账号 ID 不能重复，
          <button
            type="button"
            className="cursor-pointer border-0 bg-transparent text-brand underline"
            onClick={() => onOpenExisting(exact.influencer.id)}
          >
            查看已有达人
          </button>
        </div>
      )}
      {!!dup.data?.similar.length && (
        <div className="mt-4 rounded-lg border border-line bg-bg px-3 py-2">
          <b>疑似重复</b>（昵称相似，不会自动合并，请确认是不是同一个人）：
          <ul className="m-0 mt-1 list-none p-0">
            {dup.data.similar.map((s) => (
              <li key={s.influencer.id}>
                {s.influencer.nickname}{' '}
                <span className="text-muted">相似度 {Math.round(s.score * 100)}%</span>{' '}
                <button
                  type="button"
                  className="cursor-pointer border-0 bg-transparent text-brand underline"
                  onClick={() => onOpenExisting(s.influencer.id)}
                >
                  查看
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {err && <p className="mb-0 mt-3 text-warn">{err}</p>}
    </Modal>
  );
}

export function InfluencerDrawer({
  id,
  onClose,
  onSwitch,
}: {
  id: string;
  onClose: () => void;
  onSwitch: (id: string) => void;
}) {
  useRegisterSelection('influencer', id);
  const run = useAction();
  const q = useDetail<Row>('influencer', '/influencers', id);
  const reveal = useReveal(`/influencers/${id}/reveal`);
  const [tab, setTab] = useState('概览');
  const [dialog, setDialog] = useState<null | 'delete' | 'merge' | 'follow'>(null);
  const d = q.data;
  const inf = d?.influencer;
  const revealed = !!reveal.data;
  return (
    <Drawer title={inf ? inf.nickname : '达人'} onClose={onClose} width={720}>
      {q.isPending && <Empty>加载中…</Empty>}
      {q.isError && <Empty>{(q.error as Error).message}</Empty>}
      {d && inf && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="green">合作 {d.summary.coopCount} 次</Badge>
            <Badge>寄样 {d.summary.shipmentCount} 次</Badge>
            <Badge tone={d.summary.recycleIssueCount ? 'orange' : 'gray'}>
              回收问题 {d.summary.recycleIssueCount} 次
            </Badge>
            <span className="ml-auto flex gap-2">
              <Button onClick={reveal.toggle}>{revealed ? '隐藏敏感信息' : '查看敏感信息'}</Button>
              <Button onClick={() => setDialog('merge')}>合并到其他达人…</Button>
              <Button variant="danger" onClick={() => setDialog('delete')}>
                删除
              </Button>
            </span>
          </div>
          <Tabs
            tabs={['概览', '平台账号', '联系人', '收货地址', '合作与跟进', '样品', '变更历史']}
            value={tab}
            onChange={setTab}
          />
          {tab === '概览' && (
            <Section title="基本信息">
              <EditableFields
                specs={SPECS}
                row={revealed ? { ...inf, realName: reveal.data!.realName } : inf}
                locked={revealed ? undefined : new Set(['realName'])}
                display={(s, v) =>
                  s.type === 'money'
                    ? fmtMoney(v as number) || undefined
                    : s.key === 'refCommissionPct' && v != null
                      ? `${v}%`
                      : undefined
                }
                onSave={async (patch) => {
                  if (
                    !(await run(
                      () => patchEntity('influencer', inf.id, patch, inf.version),
                      '已保存',
                    ))
                  )
                    throw new Error('保存失败，详见提示');
                }}
              />
            </Section>
          )}
          {tab === '平台账号' && (
            <Accounts influencerId={inf.id} nickname={inf.nickname} accounts={d.accounts} />
          )}
          {tab === '联系人' && <LinkedContacts influencerId={inf.id} links={d.contacts} />}
          {tab === '收货地址' && (
            <Addresses
              influencerId={inf.id}
              addresses={revealed ? reveal.data!.addresses : d.addresses}
              revealed={revealed}
              onReveal={reveal.toggle}
            />
          )}
          {tab === '合作与跟进' && (
            <>
              <Section title="合作">
                {d.cooperations.length === 0 ? (
                  <Empty>还没有合作</Empty>
                ) : (
                  d.cooperations.map((c: Row) => (
                    <div key={c.id} className="border-b border-line py-2 last:border-0">
                      <Badge tone="green">{c.stage}</Badge>{' '}
                      {c.liveDate ? `开播 ${fmtDate(c.liveDate)}` : '档期待定'}
                    </div>
                  ))
                )}
              </Section>
              <Section
                title="跟进时间线"
                actions={
                  <Button variant="primary" onClick={() => setDialog('follow')}>
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
            </>
          )}
          {tab === '样品' && <SamplesPanel influencerId={inf.id} />}
          {tab === '变更历史' && <HistoryList logs={d.history} />}
        </div>
      )}
      {dialog === 'delete' && inf && (
        <ConfirmDialog
          title="删除达人"
          danger
          confirmLabel="删除"
          message={`确定删除「${inf.nickname}」？可在变更历史里撤销。`}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            if (
              await run(
                () => api('DELETE', `/e/influencer/${inf.id}?expectedVersion=${inf.version}`),
                '已删除',
              )
            )
              onClose();
          }}
        />
      )}
      {dialog === 'follow' && inf && (
        <FollowUpDialog target={{ influencerId: inf.id }} onClose={() => setDialog(null)} />
      )}
      {dialog === 'merge' && inf && (
        <MergeDialog current={inf} onClose={() => setDialog(null)} onSwitch={onSwitch} />
      )}
    </Drawer>
  );
}

function MergeDialog({
  current,
  onClose,
}: {
  current: Row;
  onClose: () => void;
  onSwitch: (id: string) => void;
}) {
  const run = useAction();
  const [q, setQ] = useState('');
  const [target, setTarget] = useState<Row | null>(null);
  const res = useQuery({
    queryKey: ['merge-search', q],
    enabled: q.trim().length > 0,
    queryFn: () => api<{ rows: Row[] }>('GET', '/influencers' + qs({ q, limit: 10 })),
  });
  return (
    <Modal
      title={`把「${current.nickname}」合并到…`}
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            disabled={!target}
            onClick={async () => {
              if (
                await run(() =>
                  api('POST', `/influencers/${target!.id}/merge`, { mergeId: current.id }),
                )
              )
                onClose();
            }}
          >
            提交合并申请
          </Button>
        </>
      }
    >
      <p className="mt-0 text-muted">
        合并属于敏感操作，只会生成待审核记录，到「审核」页通过后才执行：「{current.nickname}
        」的账号、合作、跟进、样品都会归到保留的达人名下，原档案被删除（可撤销）。
      </p>
      <Field label="搜索要保留的达人">
        <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="昵称或账号 ID" />
      </Field>
      <ul className="m-0 mt-2 list-none p-0">
        {res.data?.rows
          .filter((r) => r.id !== current.id)
          .map((r) => (
            <li key={r.id}>
              <label className="flex min-h-10 cursor-pointer items-center gap-2">
                <input
                  type="radio"
                  name="merge-target"
                  checked={target?.id === r.id}
                  onChange={() => setTarget(r)}
                />
                {r.nickname}{' '}
                <span className="text-muted">
                  {r.accounts.map((a: Row) => `${a.platform}:${a.accountId}`).join('、')}
                </span>
              </label>
            </li>
          ))}
      </ul>
    </Modal>
  );
}

function Accounts({
  influencerId,
  nickname,
  accounts,
}: {
  influencerId: string;
  nickname: string;
  accounts: Row[];
}) {
  const run = useAction();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(() => toForm({ platform: PLATFORMS[0] }, ACCOUNT_SPECS));
  const [err, setErr] = useState('');
  const dup = useQuery({
    queryKey: ['dup-acc', form.platform, form.accountId],
    enabled: adding && !!form.accountId?.trim(),
    queryFn: () =>
      api<{ exact: Row | null }>(
        'GET',
        '/influencers/check-duplicate' + qs({ platform: form.platform, accountId: form.accountId }),
      ),
  });
  return (
    <div className="flex flex-col gap-3">
      {accounts.length === 0 && <Empty>{nickname} 还没有平台账号</Empty>}
      {accounts.map((a) => (
        <Section
          key={a.id}
          title={`${a.platform} · ${a.accountId}`}
          actions={isStale(a.statsDate) ? <Badge tone="gray">数据超过 90 天</Badge> : undefined}
        >
          <div className={isStale(a.statsDate) ? 'opacity-60' : ''}>
            <EditableFields
              specs={ACCOUNT_SPECS}
              row={a}
              display={(s, v) =>
                s.type === 'money'
                  ? fmtMoney(v as number) || undefined
                  : s.type === 'date' && v
                    ? fmtDate(v as string)
                    : undefined
              }
              onSave={async (patch) => {
                if (
                  !(await run(
                    () => patchEntity('platform_account', a.id, patch, a.version),
                    '已保存',
                  ))
                )
                  throw new Error('保存失败，详见提示');
              }}
              extra={
                <Button
                  variant="danger"
                  onClick={() => run(() => api('DELETE', `/e/platform_account/${a.id}`), '已删除')}
                >
                  删除账号
                </Button>
              }
            />
          </div>
        </Section>
      ))}
      {adding ? (
        <Section title="添加账号">
          <FormGrid specs={ACCOUNT_SPECS} form={form} setForm={setForm} />
          {dup.data?.exact && (
            <p className="mb-0 mt-3 text-warn" role="alert">
              该账号已属于「{dup.data.exact.influencer.nickname}」，不能重复添加。
            </p>
          )}
          {err && <p className="mb-0 mt-3 text-warn">{err}</p>}
          <div className="mt-4 flex gap-2">
            <Button
              variant="primary"
              disabled={!!dup.data?.exact}
              onClick={async () => {
                try {
                  const payload = { ...fromForm(form, ACCOUNT_SPECS), influencerId };
                  setErr('');
                  if (await run(() => api('POST', '/e/platform_account', payload), '账号已添加'))
                    setAdding(false);
                } catch (e) {
                  setErr((e as Error).message);
                }
              }}
            >
              添加
            </Button>
            <Button onClick={() => setAdding(false)}>取消</Button>
          </div>
        </Section>
      ) : (
        <div>
          <Button
            onClick={() => {
              setForm(toForm({ platform: PLATFORMS[0] }, ACCOUNT_SPECS));
              setAdding(true);
            }}
          >
            添加平台账号
          </Button>
        </div>
      )}
    </div>
  );
}

function LinkedContacts({ influencerId, links }: { influencerId: string; links: Row[] }) {
  const run = useAction();
  const [q, setQ] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState<string>(CONTACT_TYPES[1]);
  const res = useQuery({
    queryKey: ['contact-search', q],
    enabled: q.trim().length > 0,
    queryFn: () => api<{ rows: Row[] }>('GET', '/contacts' + qs({ q, limit: 8 })),
  });
  const link = (contactId: string, isPrimary = false) =>
    run(() => api('POST', `/influencers/${influencerId}/contacts`, { contactId, isPrimary }));
  return (
    <div className="flex flex-col gap-3">
      <Section title="关联联系人">
        {links.length === 0 && <Empty>还没有关联联系人</Empty>}
        {links.map((l) => (
          <div
            key={l.id}
            className="flex items-center justify-between gap-2 border-b border-line py-2 last:border-0"
          >
            <span>
              {l.contact.name} <Badge>{l.contact.type}</Badge>{' '}
              {l.isPrimary && <Badge tone="green">主要对接人</Badge>}{' '}
              <span className="text-muted">
                {l.contact.org ?? ''} {l.contact.phone}
              </span>
            </span>
            <span className="flex gap-1">
              {!l.isPrimary && (
                <Button variant="ghost" onClick={() => link(l.contactId, true)}>
                  设为主要
                </Button>
              )}
              <Button
                variant="ghost"
                onClick={() => run(() => api('DELETE', `/e/influencer_contact/${l.id}`))}
              >
                取消关联
              </Button>
            </span>
          </div>
        ))}
      </Section>
      <Section title="关联已有联系人">
        <TextInput
          placeholder="搜索联系人姓名或机构"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {res.data?.rows.map((c) => (
          <div key={c.id} className="flex items-center justify-between py-1.5">
            <span>
              {c.name} <Badge>{c.type}</Badge> <span className="text-muted">{c.org ?? ''}</span>
            </span>
            <Button onClick={() => link(c.id)}>关联</Button>
          </div>
        ))}
        <h4 className="mb-2 mt-4">或新建联系人并关联</h4>
        <div className="flex gap-2">
          <TextInput placeholder="姓名" value={name} onChange={(e) => setName(e.target.value)} />
          <Select className="!w-36" value={type} onChange={(e) => setType(e.target.value)}>
            {CONTACT_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </Select>
          <Button
            variant="primary"
            onClick={async () => {
              const c = await run(() => api('POST', '/e/contact', { name, type }));
              if (c) {
                await link(c.row.id);
                setName('');
              }
            }}
          >
            新建并关联
          </Button>
        </div>
        <p className="mb-0 mt-3 text-muted">
          微信、手机等详细信息到「<Link to="/contacts">联系人</Link>」页补充。
        </p>
      </Section>
    </div>
  );
}

function Addresses({
  influencerId,
  addresses,
  revealed,
  onReveal,
}: {
  influencerId: string;
  addresses: Row[];
  revealed: boolean;
  onReveal: () => void;
}) {
  const run = useAction();
  const [form, setForm] = useState({ recipient: '', phone: '', address: '' });
  return (
    <Section
      title="收货地址（个人信息，默认打码）"
      actions={!revealed && <Button onClick={onReveal}>查看敏感信息</Button>}
    >
      {addresses.length === 0 && <Empty>还没有收货地址</Empty>}
      {addresses.map((a) => (
        <div
          key={a.id}
          className="flex items-start justify-between gap-2 border-b border-line py-2 last:border-0"
        >
          <span>
            {a.recipient} {a.phone} {a.isDefault && <Badge tone="green">默认</Badge>}
            <br />
            <span className="text-muted">{a.address}</span>
          </span>
          <span className="flex shrink-0 gap-1">
            {!a.isDefault && (
              <Button
                variant="ghost"
                onClick={() =>
                  run(() =>
                    api('PATCH', `/e/influencer_address/${a.id}`, {
                      patch: { isDefault: true },
                      expectedVersion: a.version,
                    }),
                  )
                }
              >
                设为默认
              </Button>
            )}
            <Button
              variant="ghost"
              onClick={() => run(() => api('DELETE', `/e/influencer_address/${a.id}`))}
            >
              删除
            </Button>
          </span>
        </div>
      ))}
      <div className="mt-3 grid grid-cols-[1fr_1fr_2fr_auto] gap-2">
        <TextInput
          placeholder="收件人"
          value={form.recipient}
          onChange={(e) => setForm({ ...form, recipient: e.target.value })}
        />
        <TextInput
          placeholder="手机"
          value={form.phone}
          onChange={(e) => setForm({ ...form, phone: e.target.value })}
        />
        <TextInput
          placeholder="地址"
          value={form.address}
          onChange={(e) => setForm({ ...form, address: e.target.value })}
        />
        <Button
          variant="primary"
          onClick={async () => {
            if (
              await run(
                () =>
                  api('POST', '/e/influencer_address', {
                    influencerId,
                    recipient: form.recipient,
                    phone: form.phone || null,
                    address: form.address,
                    isDefault: addresses.length === 0,
                  }),
                '地址已添加',
              )
            )
              setForm({ recipient: '', phone: '', address: '' });
          }}
        >
          添加
        </Button>
      </div>
    </Section>
  );
}

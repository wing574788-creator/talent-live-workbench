import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, downloadFile } from '../../lib/api.ts';
import { fmtDateTime } from '../../lib/format.ts';
import { useAction } from '../detail.tsx';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Empty,
  Field,
  Modal,
  Select,
  TextInput,
  useToast,
} from '../ui.tsx';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const REGION_LABEL: Record<string, string> = { domestic: '境内', foreign: '境外', local: '本机' };

interface Provider {
  id: string;
  kind: string;
  label: string;
  region: string;
  baseUrl?: string;
  models?: string[];
  hasKey: boolean;
}
interface AiConfig {
  providers: Provider[];
  purposes: Record<string, { provider: string; model: string } | null>;
  presets: { kind: string; id: string; label: string; region: string; hint: string }[];
  purposeList: { key: string; label: string }[];
  configured: boolean;
}

export const useAiConfig = () =>
  useQuery({ queryKey: ['ai-config'], queryFn: () => api<AiConfig>('GET', '/ai/config') });

// ───────────── 模型 ─────────────
export function ModelsCard() {
  const cfg = useAiConfig();
  const run = useAction();
  const [keyFor, setKeyFor] = useState<Provider | null>(null);
  const [removing, setRemoving] = useState<Provider | null>(null);
  const [adding, setAdding] = useState(false);
  const data = cfg.data;
  return (
    <Card
      title="AI 模型"
      actions={
        <Button variant="primary" onClick={() => setAdding(true)}>
          添加提供方
        </Button>
      }
    >
      {data && !data.configured && (
        <div className="mb-4 rounded-lg bg-brand-soft px-4 py-3">
          还没有配置模型，AI 助手暂时不能用，其余功能照常使用。先「添加提供方」（推荐
          DeepSeek），填入你自己的 API Key，再在下面给每个用途选一个模型。
        </div>
      )}
      <p className="mt-0 text-muted">
        API Key 只保存在这台电脑的数据目录里，不会写进数据库、不会显示在页面上、也不会出现在日志里。
      </p>
      {data?.providers.length === 0 && <Empty>还没有添加提供方</Empty>}
      {data?.providers.map((p) => (
        <div
          key={p.id}
          className="flex flex-wrap items-center justify-between gap-2 border-b border-line py-2.5 last:border-0"
        >
          <span className="flex flex-wrap items-center gap-2">
            <b>{p.label}</b>
            <Badge>{REGION_LABEL[p.region]}</Badge>
            {p.kind === 'ollama' ? (
              <Badge tone="green">无需 Key</Badge>
            ) : p.hasKey ? (
              <Badge tone="green">Key 已填写</Badge>
            ) : (
              <Badge tone="orange">未填 Key</Badge>
            )}
            {p.baseUrl && <span className="text-muted">{p.baseUrl}</span>}
          </span>
          <span className="flex gap-2">
            {p.kind !== 'ollama' && (
              <Button onClick={() => setKeyFor(p)}>{p.hasKey ? '更换 Key' : '填写 Key'}</Button>
            )}
            {p.hasKey && p.kind !== 'ollama' && (
              <Button
                variant="ghost"
                onClick={() => run(() => api('DELETE', `/ai/providers/${p.id}/key`), 'Key 已删除')}
              >
                删除 Key
              </Button>
            )}
            <Button variant="ghost" onClick={() => setRemoving(p)}>
              删除
            </Button>
          </span>
        </div>
      ))}

      {data && data.providers.length > 0 && (
        <>
          <h4 className="mb-2 mt-5">每个用途用哪个模型</h4>
          <div className="flex flex-col gap-2">
            {data.purposeList.map((pu) => (
              <PurposeRow key={pu.key} purpose={pu} config={data} />
            ))}
          </div>
          <p className="mb-0 mt-3 text-muted">
            录入提取建议选工具调用稳定的模型；首页摘要可以用便宜一点的。换模型之前，先跑一遍「工具调用回归集」。
          </p>
        </>
      )}

      {adding && data && <AddProvider config={data} onClose={() => setAdding(false)} />}
      {keyFor && <KeyDialog provider={keyFor} onClose={() => setKeyFor(null)} />}
      {removing && (
        <ConfirmDialog
          danger
          title="删除提供方"
          message={`删除「${removing.label}」会同时删除它的 API Key，并取消使用它的用途。`}
          confirmLabel="删除"
          onConfirm={() => run(() => api('DELETE', `/ai/providers/${removing.id}`), '已删除')}
          onClose={() => setRemoving(null)}
        />
      )}
    </Card>
  );
}

function PurposeRow({
  purpose,
  config,
}: {
  purpose: { key: string; label: string };
  config: AiConfig;
}) {
  const run = useAction();
  const cur = config.purposes[purpose.key];
  const [provider, setProvider] = useState(cur?.provider ?? '');
  useEffect(() => {
    setProvider(cur?.provider ?? '');
  }, [cur?.provider]);
  const models = useQuery({
    queryKey: ['ai-models', provider],
    enabled: !!provider,
    queryFn: () =>
      api<{ models: { id: string; name: string }[] }>('GET', `/ai/providers/${provider}/models`),
  });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-60">{purpose.label}</span>
      <Select
        aria-label={`${purpose.label}的提供方`}
        className="!w-44"
        value={provider}
        onChange={async (e) => {
          const v = e.target.value;
          setProvider(v);
          if (!v) await run(() => api('PUT', `/ai/purposes/${purpose.key}`, null), '已取消');
        }}
      >
        <option value="">（不使用）</option>
        {config.providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </Select>
      {provider && (
        <Select
          aria-label={`${purpose.label}的模型`}
          className="!w-56"
          value={cur?.provider === provider ? cur.model : ''}
          onChange={(e) =>
            e.target.value &&
            run(
              () => api('PUT', `/ai/purposes/${purpose.key}`, { provider, model: e.target.value }),
              '已保存',
            )
          }
        >
          <option value="">选择模型…</option>
          {models.data?.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </Select>
      )}
    </div>
  );
}

function KeyDialog({ provider, onClose }: { provider: Provider; onClose: () => void }) {
  const run = useAction();
  const [key, setKey] = useState('');
  return (
    <Modal
      title={`${provider.label} 的 API Key`}
      onClose={onClose}
      width={460}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            disabled={!key.trim()}
            onClick={async () => {
              if (
                await run(
                  () => api('PUT', `/ai/providers/${provider.id}/key`, { key }),
                  'Key 已保存',
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
      <Field label="API Key" hint="保存后页面上不会再显示它；忘了就重新填写一次。">
        <TextInput
          type="password"
          autoComplete="off"
          autoFocus
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
      </Field>
    </Modal>
  );
}

function AddProvider({ config, onClose }: { config: AiConfig; onClose: () => void }) {
  const run = useAction();
  const toast = useToast();
  const available = config.presets.filter(
    (p) => p.kind === 'openai-compatible' || !config.providers.some((x) => x.id === p.id),
  );
  const [kind, setKind] = useState(available[0]?.kind ?? 'openai-compatible');
  const preset = config.presets.find((p) => p.kind === kind)!;
  const [form, setForm] = useState({ id: '', label: '', baseUrl: '', models: '' });
  const custom = kind === 'openai-compatible';
  const needsUrl = custom || kind === 'ollama';
  return (
    <Modal
      title="添加模型提供方"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            onClick={async () => {
              const id = custom ? form.id.trim() : preset.id;
              const label = form.label.trim() || preset.label;
              if (!id || !label) return toast('请填写名称和标识', 'error');
              const body: Record<string, unknown> = { kind, label };
              if (needsUrl) {
                body.baseUrl =
                  form.baseUrl.trim() || (kind === 'ollama' ? 'http://127.0.0.1:11434/v1' : '');
                body.models = form.models.split(/[,，\s]+/).filter(Boolean);
              }
              if (await run(() => api('PUT', `/ai/providers/${id}`, body), '已添加')) onClose();
            }}
          >
            添加
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="类型" hint={preset.hint}>
          <Select value={kind} onChange={(e) => setKind(e.target.value)}>
            {available.map((p) => (
              <option key={p.kind} value={p.kind}>
                {p.kind === 'openai-compatible'
                  ? 'OpenAI 兼容接口（通义 / Kimi / 智谱…）'
                  : p.label}
              </option>
            ))}
          </Select>
        </Field>
        {custom && (
          <>
            <Field label="标识（小写字母、数字、短横线）">
              <TextInput
                value={form.id}
                placeholder="qwen"
                onChange={(e) => setForm({ ...form, id: e.target.value })}
              />
            </Field>
            <Field label="名称">
              <TextInput
                value={form.label}
                placeholder="通义千问"
                onChange={(e) => setForm({ ...form, label: e.target.value })}
              />
            </Field>
          </>
        )}
        {needsUrl && (
          <>
            <Field label="接口地址">
              <TextInput
                value={form.baseUrl}
                placeholder={kind === 'ollama' ? 'http://127.0.0.1:11434/v1' : 'https://…/v1'}
                onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              />
            </Field>
            <Field label="模型 ID（逗号分隔）">
              <TextInput
                value={form.models}
                placeholder="qwen-max, qwen-plus"
                onChange={(e) => setForm({ ...form, models: e.target.value })}
              />
            </Field>
          </>
        )}
        <p className="m-0 text-muted">
          {kind === 'ollama'
            ? '本机模型，数据不出本机。'
            : `模型所在区域：${REGION_LABEL[preset.region]}。添加后再填写 API Key。`}
        </p>
      </div>
    </Modal>
  );
}

// ───────────── 外发规则 ─────────────
interface Policy {
  allowOutbound: boolean;
  region: 'any' | 'domestic' | 'local';
  modules: Record<string, 'allow' | 'deny'>;
  fields: Record<string, 'allow' | 'deny' | 'mask'>;
}
interface OutboundData {
  policy: Policy;
  catalog: { key: string; label: string; fields: Record<string, string>; fixedMasked: string[] }[];
  fixedRule: string;
}

export function OutboundCard() {
  const run = useAction();
  const q = useQuery({
    queryKey: ['ai-outbound'],
    queryFn: () => api<OutboundData>('GET', '/ai/outbound'),
  });
  const [open, setOpen] = useState<string | null>(null);
  const d = q.data;
  if (!d) return null;
  const p = d.policy;
  const save = (next: Policy, msg = '已保存') => run(() => api('PUT', '/ai/outbound', next), msg);
  const setField = (key: string, mode: string) => {
    const fields = { ...p.fields };
    if (mode === 'allow') delete fields[key];
    else fields[key] = mode as 'deny' | 'mask';
    return save({ ...p, fields });
  };
  return (
    <Card title="外发规则">
      <div className="mb-4 rounded-lg bg-bg px-4 py-3">
        <b>固定规则（不可关闭）：</b>
        {d.fixedRule}
      </div>
      <p className="mt-0 text-muted">
        下面的设置只能在固定规则之上进一步收紧：决定哪些数据可以给模型看。
      </p>
      <div className="mb-4 flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={p.allowOutbound}
            onChange={(e) => save({ ...p, allowOutbound: e.target.checked })}
          />
          允许把数据发给云端模型
        </label>
        <label className="flex items-center gap-2">
          可用模型范围
          <Select
            className="!w-40"
            value={p.region}
            onChange={(e) => save({ ...p, region: e.target.value as Policy['region'] })}
          >
            <option value="any">不限制</option>
            <option value="domestic">仅境内</option>
            <option value="local">仅本机模型</option>
          </Select>
        </label>
      </div>
      {d.catalog.map((m) => {
        const denied = p.modules[m.key] === 'deny';
        return (
          <div key={m.key} className="border-t border-line py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                <b>{m.label}</b>
                {m.fixedMasked.length > 0 && (
                  <Badge tone="orange">固定脱敏：{m.fixedMasked.join('、')}</Badge>
                )}
                {denied && <Badge tone="red">不外发</Badge>}
              </span>
              <span className="flex gap-2">
                <Button
                  onClick={() => {
                    const modules = { ...p.modules };
                    if (denied) delete modules[m.key];
                    else modules[m.key] = 'deny';
                    save({ ...p, modules });
                  }}
                >
                  {denied ? '允许外发' : '整个模块不外发'}
                </Button>
                <Button variant="ghost" onClick={() => setOpen(open === m.key ? null : m.key)}>
                  {open === m.key ? '收起字段' : '按字段设置'}
                </Button>
              </span>
            </div>
            {open === m.key && (
              <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2">
                {Object.entries(m.fields).map(([k, label]) => (
                  <label key={k} className="flex items-center justify-between gap-2">
                    {label}
                    <Select
                      aria-label={`${m.label}·${label}`}
                      className="!w-28"
                      disabled={denied}
                      value={p.fields[`${m.key}.${k}`] ?? 'allow'}
                      onChange={(e) => setField(`${m.key}.${k}`, e.target.value)}
                    >
                      <option value="allow">可外发</option>
                      <option value="mask">打码</option>
                      <option value="deny">不外发</option>
                    </Select>
                  </label>
                ))}
              </div>
            )}
          </div>
        );
      })}
      <p className="mb-0 mt-3 text-muted">
        自定义字段默认不外发，在「自定义字段」里勾选允许外发后才会给模型看。
      </p>
    </Card>
  );
}

// ───────────── 外发日志 ─────────────
export function OutboundLogCard() {
  const toast = useToast();
  const [page, setPage] = useState(0);
  const [detail, setDetail] = useState<Row | null>(null);
  const q = useQuery({
    queryKey: ['ai-outbound-logs', page],
    queryFn: () =>
      api<{ total: number; rows: Row[] }>('GET', `/ai/outbound/logs?limit=20&offset=${page * 20}`),
  });
  const total = q.data?.total ?? 0;
  return (
    <Card
      title="外发日志"
      actions={
        <Button
          onClick={() =>
            downloadFile('GET', '/ai/outbound/logs/export', undefined, 'outbound-log.csv').catch(
              (e) => toast((e as Error).message, 'error'),
            )
          }
        >
          导出 CSV
        </Button>
      }
    >
      <p className="mt-0 text-muted">
        每次发给模型的内容都会记在这里，内容是脱敏之后实际发出的样子，可以随时核对有没有漏出手机号、微信号、地址。
      </p>
      {q.data?.rows.length === 0 && <Empty>还没有发给模型的记录</Empty>}
      {q.data?.rows.map((r) => (
        <button
          key={r.id}
          type="button"
          onClick={async () => setDetail(await api('GET', `/ai/outbound/logs/${r.id}`))}
          className="flex w-full cursor-pointer items-center gap-3 border-0 border-b border-line bg-transparent py-2 text-left text-sm last:border-0"
        >
          <span className="w-40 shrink-0 text-muted">{fmtDateTime(r.createdAt)}</span>
          <span className="w-52 shrink-0">{r.model}</span>
          <span className="w-20 shrink-0 text-muted">{r.module}</span>
          <span className="truncate text-muted">{r.preview}</span>
        </button>
      ))}
      {total > 20 && (
        <div className="mt-3 flex items-center gap-2">
          <Button disabled={page === 0} onClick={() => setPage(page - 1)}>
            上一页
          </Button>
          <span className="text-muted">
            第 {page + 1} / {Math.ceil(total / 20)} 页（共 {total} 条）
          </span>
          <Button disabled={(page + 1) * 20 >= total} onClick={() => setPage(page + 1)}>
            下一页
          </Button>
        </div>
      )}
      {detail && (
        <Modal
          title="发给模型的内容（已脱敏）"
          width={760}
          onClose={() => setDetail(null)}
          footer={<Button onClick={() => setDetail(null)}>关闭</Button>}
        >
          <p className="mt-0 text-muted">
            {fmtDateTime(detail.createdAt)} · {detail.model} · {detail.module}
          </p>
          <pre className="m-0 max-h-[60vh] overflow-auto whitespace-pre-wrap break-all rounded-lg bg-bg p-3 text-xs">
            {prettyPayload(detail.payload)}
          </pre>
        </Modal>
      )}
    </Card>
  );
}

function prettyPayload(s: string) {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

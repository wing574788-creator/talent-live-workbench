import { useState } from 'react';
import { PageHeader } from '../components/ui.tsx';
import { useRegisterSelection } from '../lib/selection.ts';
import { PRODUCT_STATUSES, PLATFORMS } from '@workbench/shared';
import { EntityList, type Col } from '../components/EntityList.tsx';
import {
  EditableFields,
  FormGrid,
  fromForm,
  toForm,
  type FieldSpec,
} from '../components/FormFields.tsx';
import { HistoryList, Section, patchEntity, useAction, useDetail } from '../components/detail.tsx';
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
import { api, uploadFile } from '../lib/api.ts';
import { fmtDate, fmtMoney } from '../lib/format.ts';
import { useQuery } from '@tanstack/react-query';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const SPECS: FieldSpec[] = [
  { key: 'styleNo', label: '款号', type: 'text', required: true },
  { key: 'name', label: '名称', type: 'text', required: true },
  { key: 'status', label: '状态', type: 'select', options: [...PRODUCT_STATUSES] },
  { key: 'mechanism', label: '机制赠品', type: 'text' },
  { key: 'dailyPriceCents', label: '日常价', type: 'money' },
  { key: 'livePriceCents', label: '直播价', type: 'money' },
  { key: 'finalPriceCents', label: '到手价', type: 'money' },
  { key: 'price1111Cents', label: '双十一价', type: 'money' },
  { key: 'price618Cents', label: '六一八价', type: 'money' },
  { key: 'sellingPoints', label: '卖点', type: 'textarea' },
];

const COLS: Col<Row>[] = [
  {
    id: 'styleNo',
    header: '款号',
    sort: 'styleNo',
    cell: (r) => (
      <span className="rounded-lg bg-ink px-2.5 py-1 text-xs font-extrabold tracking-wide text-lime">
        {r.styleNo}
      </span>
    ),
  },
  {
    id: 'name',
    header: '名称',
    sort: 'name',
    cell: (r) => <b className="text-[15px]">{r.name}</b>,
  },
  {
    id: 'status',
    header: '状态',
    sort: 'status',
    cell: (r) => <Badge tone={r.status === '在售' ? 'green' : 'gray'}>{r.status}</Badge>,
  },
  {
    id: 'livePrice',
    header: '直播价',
    sort: 'livePriceCents',
    cell: (r) => <b>{fmtMoney(r.livePriceCents)}</b>,
  },
  {
    id: 'finalPrice',
    header: '到手价',
    cell: (r) => <span className="text-muted">{fmtMoney(r.finalPriceCents)}</span>,
  },
  { id: 'mechanism', header: '机制赠品', defaultHidden: true, cell: (r) => r.mechanism ?? '' },
  {
    id: 'updatedAt',
    header: '更新时间',
    sort: 'updatedAt',
    defaultHidden: true,
    cell: (r) => fmtDate(r.updatedAt),
  },
];

export function ProductsPage() {
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="商品"
        hint="款号、价格、尺码表和平台链接；佣金设在每场合作里，不在商品上"
      />
      <EntityList
        entity="product"
        endpoint="/products"
        cols={COLS}
        filters={[{ key: 'status', label: '状态', options: [...PRODUCT_STATUSES] }]}
        searchPlaceholder="搜索款号、名称"
        onOpen={setOpenId}
        headerActions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            新建商品
          </Button>
        }
      />
      {creating && (
        <NewProduct
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setOpenId(id);
          }}
        />
      )}
      {openId && <ProductDrawer id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function useFieldSpecs(entity: string): FieldSpec[] {
  const defs = useQuery({
    queryKey: ['field_defs', entity],
    queryFn: () => api<{ rows: Row[] }>('GET', `/e/field_def?f.entity=${entity}`),
  });
  return (defs.data?.rows ?? []).map((d) => ({
    key: d.key,
    label: d.label,
    custom: true,
    type: d.type === 'multiselect' ? 'tags' : d.type,
    options: d.options ?? undefined,
  }));
}

const split = (s: string) =>
  s
    .split(/[,，、\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);

function NewProduct({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const run = useAction();
  const custom = useFieldSpecs('product');
  const specs = [...SPECS, ...custom];
  const [form, setForm] = useState(() => ({ ...toForm({ status: '在售' }, SPECS) }));
  const [colors, setColors] = useState('');
  const [sizes, setSizes] = useState('');
  const [err, setErr] = useState('');
  const variants = split(colors).flatMap((color) => split(sizes).map((size) => ({ color, size })));
  return (
    <Modal
      title="新建商品"
      onClose={onClose}
      width={680}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            onClick={async () => {
              try {
                const product = fromForm(form, specs);
                setErr('');
                const res = await run(
                  () => api('POST', '/products', { product, variants }),
                  '商品已创建',
                );
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
      <FormGrid specs={specs} form={form} setForm={setForm} />
      <div className="mt-4 grid grid-cols-2 gap-3">
        <Field label="颜色（逗号分隔）">
          <TextInput
            value={colors}
            onChange={(e) => setColors(e.target.value)}
            placeholder="黑色，驼色"
          />
        </Field>
        <Field label="尺码（逗号分隔）">
          <TextInput
            value={sizes}
            onChange={(e) => setSizes(e.target.value)}
            placeholder="S，M，L"
          />
        </Field>
      </div>
      {variants.length > 0 && (
        <p className="mb-0 mt-2 text-muted">将生成 {variants.length} 个色码规格</p>
      )}
      {err && <p className="mb-0 mt-3 text-warn">{err}</p>}
    </Modal>
  );
}

export function ProductDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  useRegisterSelection('product', id);
  const run = useAction();
  const q = useDetail<Row>('product', '/products', id);
  const custom = useFieldSpecs('product');
  const [tab, setTab] = useState('基本信息');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const d = q.data;
  const p = d?.product;
  return (
    <Drawer title={p ? `${p.styleNo} · ${p.name}` : '商品'} onClose={onClose}>
      {q.isPending && <Empty>加载中…</Empty>}
      {q.isError && <Empty>{(q.error as Error).message}</Empty>}
      {d && p && (
        <div className="flex flex-col gap-4">
          <Tabs
            tabs={['基本信息', '规格', '平台链接', '尺码表', '图片', '合作记录', '变更历史']}
            value={tab}
            onChange={setTab}
          />
          {tab === '基本信息' && (
            <Section title="基本信息">
              <EditableFields
                specs={[...SPECS, ...custom]}
                row={p}
                display={(s, v) =>
                  s.type === 'money' ? fmtMoney(v as number) || undefined : undefined
                }
                onSave={async (patch) => {
                  if (!(await run(() => patchEntity('product', p.id, patch, p.version), '已保存')))
                    throw new Error('保存失败，详见提示');
                }}
                extra={
                  <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                    删除商品
                  </Button>
                }
              />
            </Section>
          )}
          {tab === '规格' && <Variants productId={p.id} variants={d.variants} />}
          {tab === '平台链接' && <Links productId={p.id} links={d.links} />}
          {tab === '尺码表' && <SizeChart product={p} />}
          {tab === '图片' && <Images productId={p.id} images={d.images} />}
          {tab === '合作记录' && (
            <Section title="合作记录">
              {d.cooperations.length === 0 ? (
                <Empty>还没有合作用到这个商品</Empty>
              ) : (
                <ul className="m-0 list-none p-0">
                  {d.cooperations.map((c: Row) => (
                    <li key={c.id} className="border-b border-line py-2 last:border-0">
                      {c.influencerNickname} · <Badge>{c.cooperation.stage}</Badge> · 佣金{' '}
                      {c.commissionPct ?? '—'}%
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          )}
          {tab === '变更历史' && <HistoryList logs={d.history} />}
        </div>
      )}
      {confirmDelete && p && (
        <ConfirmDialog
          title="删除商品"
          danger
          confirmLabel="删除"
          message={`确定删除「${p.styleNo} ${p.name}」？删除后可在变更历史里撤销。`}
          onClose={() => setConfirmDelete(false)}
          onConfirm={async () => {
            if (
              await run(
                () => api('DELETE', `/e/product/${p.id}?expectedVersion=${p.version}`),
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

function Variants({ productId, variants }: { productId: string; variants: Row[] }) {
  const run = useAction();
  const [color, setColor] = useState('');
  const [size, setSize] = useState('');
  const grouped = new Map<string, Row[]>();
  for (const v of variants) grouped.set(v.color, [...(grouped.get(v.color) ?? []), v]);
  return (
    <Section title="色码规格">
      {variants.length === 0 && <Empty>还没有规格</Empty>}
      {[...grouped].map(([c, items]) => (
        <div
          key={c}
          className="flex flex-wrap items-center gap-2 border-b border-line py-2 last:border-0"
        >
          <b className="w-20">{c}</b>
          {items.map((v) => (
            <span
              key={v.id}
              className="inline-flex items-center gap-1 rounded-full bg-bg px-2.5 py-1"
            >
              {v.size}
              <button
                type="button"
                aria-label={`删除 ${c} ${v.size}`}
                className="cursor-pointer border-0 bg-transparent text-warn"
                onClick={() => run(() => api('DELETE', `/e/product_variant/${v.id}`))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ))}
      <div className="mt-3 flex gap-2">
        <TextInput placeholder="颜色" value={color} onChange={(e) => setColor(e.target.value)} />
        <TextInput placeholder="尺码" value={size} onChange={(e) => setSize(e.target.value)} />
        <Button
          variant="primary"
          onClick={async () => {
            if (await run(() => api('POST', '/e/product_variant', { productId, color, size }))) {
              setSize('');
            }
          }}
        >
          添加
        </Button>
      </div>
    </Section>
  );
}

function Links({ productId, links }: { productId: string; links: Row[] }) {
  const run = useAction();
  const [platform, setPlatform] = useState<string>(PLATFORMS[0]);
  const [pid, setPid] = useState('');
  const [url, setUrl] = useState('');
  return (
    <Section title="平台商品 ID / 链接">
      {links.length === 0 && <Empty>还没有平台链接</Empty>}
      {links.map((l) => (
        <div
          key={l.id}
          className="flex items-center justify-between gap-2 border-b border-line py-2 last:border-0"
        >
          <span className="min-w-0 break-all">
            <Badge>{l.platform}</Badge> {l.platformProductId}{' '}
            {l.url && (
              <a href={l.url} target="_blank" rel="noreferrer">
                链接
              </a>
            )}
          </span>
          <Button
            variant="ghost"
            onClick={() => run(() => api('DELETE', `/e/product_platform_link/${l.id}`))}
          >
            删除
          </Button>
        </div>
      ))}
      <div className="mt-3 grid grid-cols-[110px_1fr_1fr_auto] gap-2">
        <Select value={platform} onChange={(e) => setPlatform(e.target.value)}>
          {PLATFORMS.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </Select>
        <TextInput placeholder="商品 ID" value={pid} onChange={(e) => setPid(e.target.value)} />
        <TextInput placeholder="链接" value={url} onChange={(e) => setUrl(e.target.value)} />
        <Button
          variant="primary"
          onClick={async () => {
            if (
              await run(() =>
                api('POST', '/e/product_platform_link', {
                  productId,
                  platform,
                  platformProductId: pid || null,
                  url: url || null,
                }),
              )
            ) {
              setPid('');
              setUrl('');
            }
          }}
        >
          添加
        </Button>
      </div>
    </Section>
  );
}

function SizeChart({ product }: { product: Row }) {
  const run = useAction();
  const initial: Row[] = product.sizeChart ?? [];
  const [cols, setCols] = useState<string[]>(
    initial.length ? Object.keys(initial[0]!) : ['尺码', '衣长', '胸围', '肩宽'],
  );
  const [rows, setRows] = useState<Row[]>(initial);
  const [newCol, setNewCol] = useState('');
  const set = (i: number, c: string, v: string) =>
    setRows(rows.map((r, j) => (j === i ? { ...r, [c]: v } : r)));
  return (
    <Section
      title="尺码表（单位 cm）"
      actions={
        <Button
          variant="primary"
          onClick={() =>
            run(
              () =>
                patchEntity(
                  'product',
                  product.id,
                  {
                    sizeChart: rows.length
                      ? rows.map((r) =>
                          Object.fromEntries(
                            cols.map((c) => [
                              c,
                              r[c] !== '' && r[c] != null && !Number.isNaN(Number(r[c]))
                                ? Number(r[c])
                                : (r[c] ?? ''),
                            ]),
                          ),
                        )
                      : null,
                  },
                  product.version,
                ),
              '尺码表已保存',
            )
          }
        >
          保存
        </Button>
      }
    >
      <div className="overflow-x-auto">
        <table className="border-collapse">
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c} className="px-1 pb-1 text-left text-[13px] text-muted">
                  {c}
                </th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {cols.map((c) => (
                  <td key={c} className="p-1">
                    <TextInput
                      className="!w-24"
                      value={String(r[c] ?? '')}
                      onChange={(e) => set(i, c, e.target.value)}
                    />
                  </td>
                ))}
                <td>
                  <Button variant="ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                    删除
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button onClick={() => setRows([...rows, {}])}>加一行</Button>
        <TextInput
          className="!w-32"
          placeholder="新列名，如 袖长"
          value={newCol}
          onChange={(e) => setNewCol(e.target.value)}
        />
        <Button
          onClick={() => {
            if (newCol.trim() && !cols.includes(newCol.trim())) {
              setCols([...cols, newCol.trim()]);
              setNewCol('');
            }
          }}
        >
          加一列
        </Button>
      </div>
    </Section>
  );
}

function Images({ productId, images }: { productId: string; images: Row[] }) {
  const run = useAction();
  return (
    <Section
      title="产品图片（第一张为主图）"
      actions={
        <label className="inline-flex min-h-9 cursor-pointer items-center rounded-xl bg-brand px-4 text-sm font-bold text-white hover:bg-brand-dark">
          上传图片
          <input
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={async (e) => {
              for (const f of Array.from(e.target.files ?? []))
                await run(() => uploadFile(`/products/${productId}/images`, f));
              e.target.value = '';
            }}
          />
        </label>
      }
    >
      {images.length === 0 && <Empty>还没有图片</Empty>}
      <div className="grid grid-cols-3 gap-3">
        {images.map((img, i) => (
          <figure
            key={img.id}
            className="m-0 overflow-hidden rounded-2xl border border-line bg-surface"
          >
            <img
              src={`/api/attachments/${img.attachmentId}/file`}
              alt={img.attachment?.originalName ?? '产品图'}
              className="aspect-square w-full object-cover"
            />
            <figcaption className="flex items-center justify-between px-2 py-1 text-xs">
              {i === 0 ? (
                <Badge tone="green">主图</Badge>
              ) : (
                <button
                  type="button"
                  className="cursor-pointer border-0 bg-transparent text-brand"
                  onClick={() =>
                    run(() => api('POST', `/products/${productId}/images/${img.id}/primary`))
                  }
                >
                  设为主图
                </button>
              )}
              <button
                type="button"
                className="cursor-pointer border-0 bg-transparent text-warn"
                onClick={() => run(() => api('DELETE', `/e/product_image/${img.id}`))}
              >
                删除
              </button>
            </figcaption>
          </figure>
        ))}
      </div>
    </Section>
  );
}

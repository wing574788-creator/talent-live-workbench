import { useQuery, useQueryClient } from '@tanstack/react-query';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, downloadFile, qs } from '../lib/api.ts';
import { Button, ConfirmDialog, Empty, Modal, Select, TextInput, useToast } from './ui.tsx';

export interface Col<T> {
  id: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** 服务端排序列（白名单里的属性名）；不填则不可排序 */
  sort?: string;
  defaultHidden?: boolean;
}

export interface FilterSpec {
  key: string;
  label: string;
  options: string[];
}

interface FieldDef {
  id: string;
  key: string;
  label: string;
  type: string;
  options: string[] | null;
}

interface ViewConfig {
  q: string;
  filters: Record<string, string>;
  custom: Record<string, string>;
  sort?: string;
  dir: 'asc' | 'desc';
  hidden: string[];
}

const PAGE = 50;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function EntityList<T extends { id: string } = any>({
  entity,
  endpoint,
  cols,
  filters = [],
  searchPlaceholder,
  onOpen,
  headerActions,
  extraParams,
  refreshKey,
}: {
  /** 保存视图、自定义字段按这个实体名区分：product / influencer / contact */
  entity: 'product' | 'influencer' | 'contact' | 'cooperation';
  endpoint: string;
  cols: Col<T>[];
  filters?: FilterSpec[];
  searchPlaceholder: string;
  onOpen: (id: string) => void;
  headerActions?: ReactNode;
  extraParams?: Record<string, string | undefined>;
  refreshKey?: unknown;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [cfg, setCfg] = useState<ViewConfig>({
    q: '',
    filters: {},
    custom: {},
    dir: 'asc',
    hidden: cols.filter((c) => c.defaultHidden).map((c) => c.id),
  });
  const [qInput, setQInput] = useState('');
  const [page, setPage] = useState(0);
  const [showCols, setShowCols] = useState(false);
  const [naming, setNaming] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [viewName, setViewName] = useState('');

  // 搜索框防抖
  useEffect(() => {
    const t = setTimeout(() => {
      setCfg((c) => (c.q === qInput ? c : { ...c, q: qInput }));
      setPage(0);
    }, 250);
    return () => clearTimeout(t);
  }, [qInput]);

  const defs = useQuery({
    queryKey: ['field_defs', entity],
    queryFn: () => api<{ rows: FieldDef[] }>('GET', `/e/field_def?f.entity=${entity}`),
  });
  const views = useQuery({
    queryKey: ['saved_views', entity],
    queryFn: () =>
      api<{ rows: { id: string; name: string; config: ViewConfig; version: number }[] }>(
        'GET',
        `/e/saved_view?f.entity=${entity}`,
      ),
  });

  // 自定义字段作为列
  const allCols = useMemo<Col<T>[]>(
    () => [
      ...cols,
      ...(defs.data?.rows ?? []).map<Col<T>>((d) => ({
        id: `custom.${d.key}`,
        header: d.label,
        cell: (r) => {
          const v = (r as { custom?: Record<string, unknown> }).custom?.[d.key];
          return v == null
            ? ''
            : Array.isArray(v)
              ? v.join('、')
              : typeof v === 'boolean'
                ? v
                  ? '是'
                  : '否'
                : String(v);
        },
      })),
    ],
    [cols, defs.data],
  );

  const params = {
    q: cfg.q,
    sort: cfg.sort,
    dir: cfg.dir,
    limit: PAGE,
    offset: page * PAGE,
    ...Object.fromEntries(Object.entries(cfg.filters).map(([k, v]) => [`f.${k}`, v])),
    ...Object.fromEntries(Object.entries(cfg.custom).map(([k, v]) => [`c.${k}`, v])),
    ...extraParams,
  };
  const list = useQuery({
    queryKey: ['list', endpoint, params, refreshKey],
    queryFn: () => api<{ rows: T[]; total: number }>('GET', endpoint + qs(params)),
    placeholderData: (prev) => prev,
  });

  const columns = useMemo<ColumnDef<T>[]>(
    () =>
      allCols.map((c) => ({
        id: c.id,
        header: c.header,
        cell: ({ row }) => c.cell(row.original),
        meta: { sort: c.sort },
      })),
    [allCols],
  );
  const table = useReactTable({
    data: list.data?.rows ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (r) => r.id,
    state: { columnVisibility: Object.fromEntries(cfg.hidden.map((h) => [h, false])) },
    manualSorting: true,
  });

  const total = list.data?.total ?? 0;
  const selectCustom = (defs.data?.rows ?? []).filter(
    (d) => d.type === 'select' && d.options?.length,
  );

  async function saveView(name: string) {
    if (!name.trim()) return;
    try {
      await api('POST', '/e/saved_view', { entity, name: name.trim(), config: cfg });
      await qc.invalidateQueries({ queryKey: ['saved_views', entity] });
      toast('视图已保存');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }
  async function deleteView(id: string) {
    await api('DELETE', `/e/saved_view/${id}`);
    await qc.invalidateQueries({ queryKey: ['saved_views', entity] });
  }
  function applyView(c: ViewConfig) {
    setCfg({ ...c });
    setQInput(c.q ?? '');
    setPage(0);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="w-64">
          <TextInput
            type="search"
            aria-label="搜索"
            placeholder={searchPlaceholder}
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
          />
        </div>
        {filters.map((f) => (
          <Select
            key={f.key}
            aria-label={f.label}
            className="!w-auto"
            value={cfg.filters[f.key] ?? ''}
            onChange={(e) => {
              setCfg({ ...cfg, filters: { ...cfg.filters, [f.key]: e.target.value } });
              setPage(0);
            }}
          >
            <option value="">{f.label}：全部</option>
            {f.options.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </Select>
        ))}
        {selectCustom.map((d) => (
          <Select
            key={d.key}
            aria-label={d.label}
            className="!w-auto"
            value={cfg.custom[d.key] ?? ''}
            onChange={(e) => {
              setCfg({ ...cfg, custom: { ...cfg.custom, [d.key]: e.target.value } });
              setPage(0);
            }}
          >
            <option value="">{d.label}：全部</option>
            {d.options!.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </Select>
        ))}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Select
            aria-label="保存的视图"
            className="!w-auto"
            value=""
            onChange={(e) => {
              const v = views.data?.rows.find((x) => x.id === e.target.value);
              if (v) applyView(v.config);
            }}
          >
            <option value="">视图…</option>
            {views.data?.rows.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </Select>
          <Button
            onClick={() => {
              setViewName('');
              setNaming(true);
            }}
          >
            保存视图
          </Button>
          <Button onClick={() => setExporting(true)}>导出</Button>
          <div className="relative">
            <Button onClick={() => setShowCols(!showCols)}>列</Button>
            {showCols && (
              <div className="absolute right-0 top-10 z-20 w-48 rounded-lg border border-line bg-surface p-2 shadow-lg">
                {allCols.map((c) => (
                  <label key={c.id} className="flex min-h-8 cursor-pointer items-center gap-2 px-1">
                    <input
                      type="checkbox"
                      checked={!cfg.hidden.includes(c.id)}
                      onChange={(e) =>
                        setCfg({
                          ...cfg,
                          hidden: e.target.checked
                            ? cfg.hidden.filter((h) => h !== c.id)
                            : [...cfg.hidden, c.id],
                        })
                      }
                    />
                    {c.header}
                  </label>
                ))}
              </div>
            )}
          </div>
          {headerActions}
        </div>
      </div>

      {views.data && views.data.rows.length > 0 && (
        <div className="flex flex-wrap gap-2 text-xs text-muted">
          {views.data.rows.map((v) => (
            <span key={v.id} className="rounded-md bg-surface px-2 py-1">
              {v.name}{' '}
              <button
                type="button"
                className="cursor-pointer border-0 bg-transparent text-warn"
                onClick={() => deleteView(v.id)}
                aria-label={`删除视图 ${v.name}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full border-collapse text-left">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id} className="border-b border-line bg-bg">
                {hg.headers.map((h) => {
                  const sort = (h.column.columnDef.meta as { sort?: string } | undefined)?.sort;
                  const active = sort && cfg.sort === sort;
                  return (
                    <th
                      key={h.id}
                      className="whitespace-nowrap px-3 py-2.5 text-[13px] font-medium text-muted"
                    >
                      {sort ? (
                        <button
                          type="button"
                          className="cursor-pointer border-0 bg-transparent p-0 font-medium text-inherit"
                          onClick={() =>
                            setCfg({
                              ...cfg,
                              sort,
                              dir: active && cfg.dir === 'asc' ? 'desc' : 'asc',
                            })
                          }
                        >
                          {flexRender(h.column.columnDef.header, h.getContext())}
                          {active ? (cfg.dir === 'asc' ? ' ↑' : ' ↓') : ''}
                        </button>
                      ) : (
                        flexRender(h.column.columnDef.header, h.getContext())
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((r) => (
              <tr
                key={r.id}
                className="cursor-pointer border-b border-line last:border-0 hover:bg-bg"
                onClick={() => onOpen(r.id)}
              >
                {r.getVisibleCells().map((c) => (
                  <td key={c.id} className="px-3 py-2.5 align-top">
                    {flexRender(c.column.columnDef.cell, c.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {list.isPending && <Empty>加载中…</Empty>}
        {list.isError && <Empty>加载失败：{(list.error as Error).message}</Empty>}
        {list.data && list.data.rows.length === 0 && <Empty>没有符合条件的记录</Empty>}
      </div>

      {exporting && (
        <ConfirmDialog
          title="导出当前列表"
          confirmLabel="导出 Excel"
          message="按当前的搜索和筛选导出为 .xlsx，包含自定义字段。文件里有手机、微信、收货地址等个人信息，请妥善保管。"
          onClose={() => setExporting(false)}
          onConfirm={() => {
            const rest: Record<string, string | number | undefined> = { ...params };
            delete rest.limit;
            delete rest.offset;
            void downloadFile('GET', `/export/list/${entity}${qs(rest)}`).catch((err) =>
              toast((err as Error).message, 'error'),
            );
          }}
        />
      )}
      {naming && (
        <Modal
          title="保存当前视图"
          width={400}
          onClose={() => setNaming(false)}
          footer={
            <>
              <Button onClick={() => setNaming(false)}>取消</Button>
              <Button
                variant="primary"
                disabled={!viewName.trim()}
                onClick={async () => {
                  await saveView(viewName);
                  setNaming(false);
                }}
              >
                保存
              </Button>
            </>
          }
        >
          <TextInput
            autoFocus
            aria-label="视图名称"
            placeholder="视图名称，如 在售大衣"
            value={viewName}
            onChange={(e) => setViewName(e.target.value)}
          />
        </Modal>
      )}
      <div className="flex items-center justify-between text-muted">
        <span>共 {total} 条</span>
        <div className="flex items-center gap-2">
          <Button disabled={page === 0} onClick={() => setPage(page - 1)}>
            上一页
          </Button>
          <span>
            {page + 1} / {Math.max(1, Math.ceil(total / PAGE))}
          </span>
          <Button disabled={(page + 1) * PAGE >= total} onClick={() => setPage(page + 1)}>
            下一页
          </Button>
        </div>
      </div>
    </div>
  );
}

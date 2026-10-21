import { useQuery, useQueryClient } from '@tanstack/react-query';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, downloadFile, qs } from '../lib/api.ts';
import {
  Button,
  ConfirmDialog,
  Empty,
  Modal,
  Select,
  TABLE,
  TextInput,
  cx,
  useToast,
} from './ui.tsx';

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

const POPOVER = 'absolute top-11 z-20 rounded-2xl border border-line bg-surface p-2.5 shadow-xl';
const MENU_ITEM =
  'flex min-h-8 w-full cursor-pointer items-center rounded-lg border-0 bg-transparent px-2 text-left text-sm text-ink hover:bg-bg';

/** 按筛选下拉个数选工具栏容器宽度断点：够宽就直接摆出下拉，否则收进「筛选」弹层。类名要写全，Tailwind 才扫描得到 */
const INLINE_AT = [
  { show: '', hide: '' },
  { show: '@2xl:flex', hide: '@2xl:hidden' },
  { show: '@3xl:flex', hide: '@3xl:hidden' },
  { show: '@4xl:flex', hide: '@4xl:hidden' },
  { show: '@5xl:flex', hide: '@5xl:hidden' },
  { show: '@6xl:flex', hide: '@6xl:hidden' },
];

/** 弹层开关：点外面或按 Esc 关闭 */
function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return { open, setOpen, ref };
}

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
  const filterPop = usePopover();
  const viewPop = usePopover();
  const morePop = usePopover();

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

  const activeFilters =
    Object.values(cfg.filters).filter(Boolean).length +
    Object.values(cfg.custom).filter(Boolean).length;
  const filterCount = filters.length + selectCustom.length;
  // 筛选下拉越多，需要的宽度越大；容器比断点窄就收进「筛选」按钮
  const inlineAt = INLINE_AT[Math.min(filterCount, INLINE_AT.length - 1)]!;

  const filterSelects = (
    <>
      {filters.map((f) => (
        <Select
          key={f.key}
          aria-label={f.label}
          className="!w-auto shrink-0"
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
          className="!w-auto shrink-0"
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
    </>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="@container">
        <div className="flex flex-nowrap items-center gap-3">
          <div className="min-w-40 max-w-72 flex-1">
            <TextInput
              type="search"
              aria-label="搜索"
              placeholder={searchPlaceholder}
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
            />
          </div>
          {filterCount > 0 && (
            <>
              <div className={cx('hidden shrink-0 items-center gap-3', inlineAt.show)}>
                {filterSelects}
              </div>
              <div ref={filterPop.ref} className={cx('relative shrink-0', inlineAt.hide)}>
                <Button
                  aria-expanded={filterPop.open}
                  onClick={() => filterPop.setOpen(!filterPop.open)}
                >
                  {activeFilters ? `筛选（已选 ${activeFilters} 项）` : '筛选'}
                </Button>
                {filterPop.open && (
                  <div
                    className={cx(POPOVER, 'left-0 flex w-56 flex-col gap-2 [&>select]:!w-full')}
                  >
                    {filterSelects}
                  </div>
                )}
              </div>
            </>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <div ref={viewPop.ref} className="relative">
              <Button aria-expanded={viewPop.open} onClick={() => viewPop.setOpen(!viewPop.open)}>
                视图 ▾
              </Button>
              {viewPop.open && (
                <div className={cx(POPOVER, 'right-0 w-56')} role="menu">
                  {views.data?.rows.length ? (
                    views.data.rows.map((v) => (
                      <button
                        key={v.id}
                        type="button"
                        role="menuitem"
                        className={MENU_ITEM}
                        onClick={() => {
                          applyView(v.config);
                          viewPop.setOpen(false);
                        }}
                      >
                        {v.name}
                      </button>
                    ))
                  ) : (
                    <div className="px-2 py-1.5 text-sm text-muted">还没有保存的视图</div>
                  )}
                  <div className="my-1.5 border-t border-line" />
                  <button
                    type="button"
                    role="menuitem"
                    className={MENU_ITEM}
                    onClick={() => {
                      viewPop.setOpen(false);
                      setViewName('');
                      setNaming(true);
                    }}
                  >
                    保存当前视图…
                  </button>
                </div>
              )}
            </div>
            <div ref={morePop.ref} className="relative">
              <Button
                aria-label="更多操作"
                aria-expanded={morePop.open}
                className="!px-3"
                onClick={() => {
                  morePop.setOpen(!morePop.open);
                  setShowCols(false);
                }}
              >
                ···
              </Button>
              {morePop.open &&
                (showCols ? (
                  <div className={cx(POPOVER, 'right-0 w-52')}>
                    {allCols.map((c) => (
                      <label
                        key={c.id}
                        className="flex min-h-8 cursor-pointer items-center gap-2 px-1"
                      >
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
                ) : (
                  <div className={cx(POPOVER, 'right-0 w-40')} role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      className={MENU_ITEM}
                      onClick={() => {
                        morePop.setOpen(false);
                        setExporting(true);
                      }}
                    >
                      导出…
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className={MENU_ITEM}
                      onClick={() => setShowCols(true)}
                    >
                      显示列
                    </button>
                  </div>
                ))}
            </div>
            {headerActions}
          </div>
        </div>
      </div>

      {views.data && views.data.rows.length > 0 && (
        <div className="flex flex-wrap gap-2 text-xs text-muted">
          {views.data.rows.map((v) => (
            <span key={v.id} className="rounded-full bg-surface px-3 py-1">
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

      <div className={TABLE.wrap}>
        <table className="w-full border-collapse text-left">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id} className={TABLE.headRow}>
                {hg.headers.map((h) => {
                  const sort = (h.column.columnDef.meta as { sort?: string } | undefined)?.sort;
                  const active = sort && cfg.sort === sort;
                  return (
                    <th key={h.id} className={TABLE.th}>
                      {sort ? (
                        <button
                          type="button"
                          className="cursor-pointer border-0 bg-transparent p-0 font-bold text-inherit"
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
              <tr key={r.id} className={TABLE.row} onClick={() => onOpen(r.id)}>
                {r.getVisibleCells().map((c) => (
                  <td key={c.id} className={TABLE.td}>
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

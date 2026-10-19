import { useState } from 'react';
import { downloadFile } from '../../lib/api.ts';
import { fmtValue } from '../../lib/labels.ts';
import { Badge, Button, Select, useToast } from '../ui.tsx';
import {
  DECISION_LABEL,
  POLICY_LABEL,
  toConfigs,
  type Decision,
  type Decisions,
  type FieldPolicy,
  type Meta,
  type SheetState,
} from './shared.ts';

export interface DryRow {
  rowNo: number;
  status: 'new' | 'update' | 'duplicate' | 'error';
  issues: { level: 'warn' | 'error'; text: string }[];
  summary: string;
  existingLabel?: string;
  suspects?: { id: string; label: string; score: number }[];
  changes?: { field: string; label: string; before: unknown; after: unknown }[];
  decision?: Decision;
}
export interface DrySheet {
  sheet: string;
  target: string;
  stats: {
    total: number;
    new: number;
    update: number;
    duplicate: number;
    error: number;
    warning: number;
  };
  rows: DryRow[];
  enums: {
    field: string;
    label: string;
    options: string[];
    values: {
      raw: string;
      count: number;
      mapped: string | null;
      auto: boolean;
      decided: boolean;
    }[];
  }[];
  unmappedEnums: number;
  undecided: number;
  newCustomFields: { key: string; label: string; type: string }[];
  configIssues: string[];
}

type Filter = 'all' | 'new' | 'update' | 'duplicate' | 'warning' | 'error';
const STATUS: Record<DryRow['status'], { label: string; cls: string }> = {
  new: { label: '新增', cls: 'bg-brand-soft text-brand' },
  update: { label: '更新', cls: 'bg-blue-50 text-blue-700' },
  duplicate: { label: '疑似重复', cls: 'bg-orange-50 text-warn' },
  error: { label: '错误', cls: 'bg-red-50 text-red-700' },
};
const SHOW = 200;

/** 第 4 步：预演。逐行看结果，处理枚举值、疑似重复，选择合并策略；不写入数据库。 */
export function PreviewStep(props: {
  sessionId: string;
  sheets: SheetState[];
  setSheets: (s: SheetState[]) => void;
  decisions: Decisions;
  setDecisions: (d: Decisions) => void;
  dry: DrySheet[] | undefined;
  loading: boolean;
  meta: Meta;
}) {
  const { dry, sheets, loading } = props;
  if (!dry) return <p className="text-muted">{loading ? '正在预演…' : '没有可预演的内容'}</p>;
  return (
    <div className="flex flex-col gap-5">
      <p className="m-0 text-muted">
        这一步只是预演，不会写入任何数据。逐行标出是新增、更新还是疑似重复，有警告或错误的会写明原因。先处理枚举值和疑似重复，再进入下一步提交。
      </p>
      {dry.map((ds) => {
        const sheet = sheets.find((s) => s.name === ds.sheet);
        return sheet ? <SheetPreview key={ds.sheet} {...props} ds={ds} sheet={sheet} /> : null;
      })}
    </div>
  );
}

function SheetPreview({
  sessionId,
  sheets,
  setSheets,
  decisions,
  setDecisions,
  ds,
  sheet,
  meta,
}: Parameters<typeof PreviewStep>[0] & { ds: DrySheet; sheet: SheetState }) {
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>('all');
  const [limit, setLimit] = useState(SHOW);
  const label = meta.targets[ds.target as keyof Meta['targets']].label;
  const dec = decisions[ds.sheet] ?? {};

  const rows = ds.rows.filter(
    (r) =>
      filter === 'all' ||
      (filter === 'warning' ? r.issues.some((i) => i.level === 'warn') : r.status === filter),
  );
  const chips: { key: Filter; text: string; n: number }[] = [
    { key: 'all', text: '全部', n: ds.stats.total },
    { key: 'new', text: '新增', n: ds.stats.new },
    { key: 'update', text: '更新', n: ds.stats.update },
    { key: 'duplicate', text: '疑似重复', n: ds.stats.duplicate },
    { key: 'warning', text: '警告', n: ds.stats.warning },
    { key: 'error', text: '错误', n: ds.stats.error },
  ];

  const patchSheet = (fn: (s: SheetState) => SheetState) =>
    setSheets(sheets.map((s) => (s.name === sheet.name ? fn(s) : s)));
  const setDecision = (rowNo: number, v: string) => {
    const rowsMap = { ...(dec.rows ?? {}) };
    if (v) rowsMap[rowNo] = v as Decision;
    else delete rowsMap[rowNo];
    setDecisions({ ...decisions, [ds.sheet]: { ...dec, rows: rowsMap } });
  };
  const bulk = (v: Decision) => {
    const rowsMap = { ...(dec.rows ?? {}) };
    for (const r of ds.rows) if (r.status === 'duplicate') delete rowsMap[r.rowNo];
    setDecisions({ ...decisions, [ds.sheet]: { rows: rowsMap, duplicates: v } });
  };
  const setEnum = (field: string, raw: string, v: string) =>
    patchSheet((s) => ({
      ...s,
      enumMap: {
        ...s.enumMap,
        [field]: { ...(s.enumMap[field] ?? {}), [raw]: v === '__empty' ? null : v },
      },
    }));

  const mappedFields = Object.values(sheet.mapping).flatMap((m) =>
    m.kind === 'field' ? [m.field] : [],
  );
  const fieldLabel = (key: string) =>
    meta.targets[sheet.target].fields.find((f) => f.key === key)?.label ?? key;
  const hasMerge = ds.stats.update + ds.stats.duplicate > 0;

  return (
    <section className="rounded-xl border border-line bg-surface p-4">
      <h3 className="m-0 text-base">
        {ds.sheet} <span className="font-normal text-muted">→ {label}</span>
      </h3>
      <div className="mt-2 flex flex-wrap gap-2">
        {chips.map((c) => (
          <Button
            key={c.key}
            variant={filter === c.key ? 'primary' : 'secondary'}
            onClick={() => {
              setFilter(c.key);
              setLimit(SHOW);
            }}
            disabled={c.key !== 'all' && c.n === 0}
          >
            {c.text} {c.n}
          </Button>
        ))}
        {ds.stats.error > 0 && (
          <Button
            onClick={() =>
              downloadFile(
                'POST',
                `/import/${sessionId}/errors`,
                { configs: toConfigs(sheets), decisions },
                '导入错误行.xlsx',
              ).catch((e) => toast((e as Error).message, 'error'))
            }
          >
            导出错误行
          </Button>
        )}
      </div>

      {ds.configIssues.length > 0 && (
        <div
          className="mt-3 rounded-lg border border-warn bg-orange-50 px-3 py-2 text-warn"
          role="alert"
        >
          {ds.configIssues.map((t) => (
            <div key={t}>{t}</div>
          ))}
          <div className="text-[13px]">回到上一步修改列映射。</div>
        </div>
      )}
      {ds.newCustomFields.length > 0 && (
        <p className="mb-0 mt-3 text-[13px] text-muted">
          提交时会新建自定义字段：{ds.newCustomFields.map((f) => f.label).join('、')}
        </p>
      )}

      {ds.enums.length > 0 && (
        <div className="mt-4">
          <h4 className="m-0 mb-2">
            枚举值对应
            {ds.unmappedEnums > 0 && (
              <>
                {' '}
                <Badge tone="red">{ds.unmappedEnums} 个没有对应的系统选项</Badge>
              </>
            )}
          </h4>
          {ds.enums.map((e) => (
            <table
              key={e.field}
              className="mb-3 w-full max-w-xl border-collapse text-left text-[13px]"
            >
              <thead>
                <tr className="text-muted">
                  <th className="py-1 pr-3 font-medium">「{e.label}」表里的值</th>
                  <th className="py-1 pr-3 font-medium">出现次数</th>
                  <th className="py-1 font-medium">对应的系统选项</th>
                </tr>
              </thead>
              <tbody>
                {e.values.map((v) => (
                  <tr key={v.raw} className="border-t border-line">
                    <td className="py-1.5 pr-3">{v.raw}</td>
                    <td className="py-1.5 pr-3">{v.count}</td>
                    <td className="py-1.5">
                      <Select
                        aria-label={`${e.label} 的值 ${v.raw} 对应`}
                        className={!v.decided ? '!border-warn' : ''}
                        value={v.decided ? (v.mapped ?? '__empty') : ''}
                        onChange={(ev) => setEnum(e.field, v.raw, ev.target.value)}
                      >
                        {!v.decided && <option value="">请选择…</option>}
                        {e.options.map((o) => (
                          <option key={o} value={o}>
                            {o}
                          </option>
                        ))}
                        <option value="__empty">留空（这个值不导入）</option>
                      </Select>
                      {v.auto && <span className="ml-2 text-xs text-muted">自动识别</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
        </div>
      )}

      {hasMerge && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <span>合并到已有记录时：</span>
          <Select
            aria-label="合并策略"
            className="!w-auto"
            value={sheet.policy.default}
            onChange={(e) =>
              patchSheet((s) => ({
                ...s,
                policy: { ...s.policy, default: e.target.value as FieldPolicy },
              }))
            }
          >
            {(Object.keys(POLICY_LABEL) as FieldPolicy[]).map((p) => (
              <option key={p} value={p}>
                {POLICY_LABEL[p]}
              </option>
            ))}
          </Select>
          <details className="text-[13px]">
            <summary className="cursor-pointer text-brand">按字段单独设置</summary>
            <div className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2">
              {mappedFields.map((f) => (
                <label key={f} className="flex items-center justify-between gap-2">
                  {fieldLabel(f)}
                  <Select
                    aria-label={`${fieldLabel(f)} 合并策略`}
                    className="!w-32"
                    value={sheet.policy.fields[f] ?? ''}
                    onChange={(e) =>
                      patchSheet((s) => {
                        const fields = { ...s.policy.fields };
                        if (e.target.value) fields[f] = e.target.value as FieldPolicy;
                        else delete fields[f];
                        return { ...s, policy: { ...s.policy, fields } };
                      })
                    }
                  >
                    <option value="">跟随默认</option>
                    {(Object.keys(POLICY_LABEL) as FieldPolicy[]).map((p) => (
                      <option key={p} value={p}>
                        {POLICY_LABEL[p]}
                      </option>
                    ))}
                  </Select>
                </label>
              ))}
            </div>
          </details>
          <span className="text-xs text-muted">
            金额、佣金这类敏感字段被改动时，导入的改动会先进「审核」，不会直接生效。
          </span>
        </div>
      )}

      {ds.stats.duplicate > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-bg px-3 py-2">
          <b>疑似重复 {ds.stats.duplicate} 条</b>
          {ds.undecided > 0 ? (
            <Badge tone="red">{ds.undecided} 条还没裁决</Badge>
          ) : (
            <Badge tone="green">都已裁决</Badge>
          )}
          <span className="text-muted">
            昵称相似不会自动合并，逐条选择合并、跳过或新建，或一次处理全部：
          </span>
          {(['merge', 'skip', 'new'] as Decision[]).map((d) => (
            <Button key={d} onClick={() => bulk(d)}>
              全部{DECISION_LABEL[d]}
            </Button>
          ))}
        </div>
      )}

      <div className="mt-3 overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-[760px] border-collapse text-left text-[13px]">
          <thead>
            <tr className="bg-bg text-muted">
              {['行', '状态', '内容', '提示', '处理'].map((h) => (
                <th key={h} className="px-2 py-2 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, limit).map((r) => (
              <tr key={r.rowNo} className="border-t border-line align-top">
                <td className="px-2 py-2 text-muted">{r.rowNo}</td>
                <td className="px-2 py-2">
                  <span
                    className={`whitespace-nowrap rounded-md px-2 py-0.5 text-xs ${STATUS[r.status].cls}`}
                  >
                    {STATUS[r.status].label}
                  </span>
                </td>
                <td className="px-2 py-2">
                  <div>{r.summary}</div>
                  {r.existingLabel && (
                    <div className="text-xs text-muted">对应：{r.existingLabel}</div>
                  )}
                  {r.suspects?.map((s) => (
                    <div key={s.id} className="text-xs text-warn">
                      疑似「{s.label}」
                      {s.score < 1 ? `（相似度 ${Math.round(s.score * 100)}%）` : ''}
                    </div>
                  ))}
                  {r.changes && r.changes.length > 0 && (
                    <div className="mt-1 text-xs text-muted">
                      {r.changes.slice(0, 4).map((c) => (
                        <div key={c.field}>
                          {c.label}：{fmtValue(c.field, c.before)} →{' '}
                          <span className="text-ink">{fmtValue(c.field, c.after)}</span>
                        </div>
                      ))}
                      {r.changes.length > 4 && <div>… 共 {r.changes.length} 项</div>}
                    </div>
                  )}
                </td>
                <td className="px-2 py-2">
                  {r.issues.map((i, k) => (
                    <div key={k} className={i.level === 'error' ? 'text-red-700' : 'text-warn'}>
                      {i.level === 'error' ? '✕ ' : '⚠ '}
                      {i.text}
                    </div>
                  ))}
                </td>
                <td className="px-2 py-2">
                  {r.status === 'duplicate' && (
                    <Select
                      aria-label={`第 ${r.rowNo} 行裁决`}
                      className={`!w-28 ${!r.decision ? '!border-warn' : ''}`}
                      value={r.decision ?? ''}
                      onChange={(e) => setDecision(r.rowNo, e.target.value)}
                    >
                      <option value="">请裁决…</option>
                      {(['merge', 'skip', 'new'] as Decision[]).map((d) => (
                        <option key={d} value={d}>
                          {DECISION_LABEL[d]}
                        </option>
                      ))}
                    </Select>
                  )}
                  {r.status === 'update' && (
                    <Select
                      aria-label={`第 ${r.rowNo} 行处理`}
                      className="!w-28"
                      value={r.decision ?? 'merge'}
                      onChange={(e) => setDecision(r.rowNo, e.target.value)}
                    >
                      <option value="merge">合并</option>
                      <option value="skip">跳过</option>
                    </Select>
                  )}
                  {r.status === 'new' && <span className="text-muted">新建</span>}
                  {r.status === 'error' && <span className="text-muted">不导入</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <div className="px-3 py-4 text-center text-muted">没有符合条件的行</div>
        )}
        {rows.length > limit && (
          <div className="border-t border-line px-3 py-2 text-center">
            <Button onClick={() => setLimit(limit + SHOW)}>
              再显示 {Math.min(SHOW, rows.length - limit)} 行（还有 {rows.length - limit} 行）
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

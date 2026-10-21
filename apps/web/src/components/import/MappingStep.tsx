import { useState } from 'react';
import { api } from '../../lib/api.ts';
import { Badge, Button, Select, TextInput, useToast } from '../ui.tsx';
import { useAiFeature } from '../ai/AiSettings.tsx';
import {
  CUSTOM_TYPE_LABEL,
  cellText,
  type ColumnMapping,
  type CustomType,
  type Meta,
  type SheetState,
} from './shared.ts';

const encode = (m: ColumnMapping | undefined): string =>
  !m || m.kind === 'ignore' ? 'ignore' : m.kind === 'field' ? `f:${m.field}` : m.kind;

/** 第 3 步：列映射 + 值转换。左边是源列和样本，右边选目标字段。 */
export function MappingStep({
  sheets,
  setSheets,
  meta,
}: {
  sheets: SheetState[];
  setSheets: (s: SheetState[]) => void;
  meta: Meta;
}) {
  const update = (name: string, fn: (s: SheetState) => SheetState) =>
    setSheets(sheets.map((s) => (s.name === name ? fn(s) : s)));
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const mappingOn = useAiFeature('mapping');
  /** 由 AI 建议填进来的列（提醒用户再看一眼） */
  const [aiCols, setAiCols] = useState<Record<string, number[]>>({});

  async function askAi(s: SheetState) {
    setBusy(s.name);
    try {
      const res = await api<{
        source: string;
        message?: string;
        suggestions: { columnIndex: number; mapping: ColumnMapping; source: string }[];
      }>('POST', '/ai/mapping-suggest', {
        target: s.target,
        columns: s.columns.map((c) => ({
          index: c.index,
          name: c.name,
          samples: c.samples.slice(0, 3),
        })),
      });
      const fresh = res.suggestions.filter(
        (g) => g.source === 'ai' && !s.mapping[String(g.columnIndex)],
      );
      if (fresh.length) {
        update(s.name, (x) => {
          const mapping = { ...x.mapping };
          for (const g of fresh) mapping[String(g.columnIndex)] = g.mapping;
          return { ...x, mapping };
        });
        setAiCols({ ...aiCols, [s.name]: fresh.map((g) => g.columnIndex) });
        toast(`AI 补充了 ${fresh.length} 列的建议，请逐列确认`);
      } else {
        toast(res.message ?? 'AI 没有给出新的建议');
      }
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="m-0 text-muted">
        左边是表里的列和前 5
        个样本，右边选它导入到哪个字段。可以新建自定义字段、存为原始值（原样保存，不做转换）或忽略。金额、日期、粉丝数、百分比会按下面的转换规则自动转换；无法转换的值会原样存进「导入原始值」并标黄提示，不会丢。
      </p>
      {sheets
        .filter((s) => s.include)
        .map((s) => {
          const target = meta.targets[s.target];
          const used = new Map<string, number>();
          for (const [idx, m] of Object.entries(s.mapping))
            if (m.kind === 'field') used.set(m.field, Number(idx));
          const missing = target.fields.filter((f) => f.required && !used.has(f.key));

          const setMapping = (
            colIndex: number,
            value: string,
            colName: string,
            customKey: string,
          ) => {
            update(s.name, (x) => {
              const mapping = { ...x.mapping };
              const key = String(colIndex);
              if (value === 'ignore') delete mapping[key];
              else if (value === 'raw') mapping[key] = { kind: 'raw' };
              else if (value === 'custom')
                mapping[key] = { kind: 'custom', key: customKey, label: colName, type: 'text' };
              else {
                const field = value.slice(2);
                for (const [k, m] of Object.entries(mapping))
                  if (m.kind === 'field' && m.field === field) delete mapping[k]; // 一个字段只对应一列
                mapping[key] = { kind: 'field', field };
              }
              return { ...x, mapping };
            });
          };
          const patchMapping = (colIndex: number, patch: Partial<ColumnMapping>) =>
            update(s.name, (x) => ({
              ...x,
              mapping: {
                ...x.mapping,
                [String(colIndex)]: { ...x.mapping[String(colIndex)], ...patch } as ColumnMapping,
              },
            }));

          return (
            <section
              key={s.name}
              className="rounded-3xl bg-surface p-5 shadow-[0_1px_0_var(--color-line)]"
            >
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h3 className="m-0 text-base">
                  {s.name}{' '}
                  <span className="font-normal text-muted">→ 导入成「{target.label}」</span>
                </h3>
                {mappingOn && (
                  <Button disabled={busy === s.name} onClick={() => askAi(s)}>
                    {busy === s.name ? 'AI 分析中…' : 'AI 建议映射'}
                  </Button>
                )}
              </div>
              {missing.length > 0 && (
                <p
                  className="mb-3 mt-0 rounded-2xl bg-amber-soft px-4 py-2.5 text-[#8a4b00]"
                  role="alert"
                >
                  必填字段还没有对应的列：{missing.map((f) => f.label).join('、')}
                  。没有它们这张表无法导入。
                </p>
              )}
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left">
                  <thead>
                    <tr className="text-[13px] text-muted">
                      <th className="px-2 py-1.5 font-medium">表里的列</th>
                      <th className="px-2 py-1.5 font-medium">前 5 个样本</th>
                      <th className="px-2 py-1.5 font-medium">导入到</th>
                      <th className="px-2 py-1.5 font-medium">值转换</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.columns.map((col) => {
                      const m = s.mapping[String(col.index)];
                      const field =
                        m?.kind === 'field'
                          ? target.fields.find((f) => f.key === m.field)
                          : undefined;
                      const sug = s.suggestions.find((g) => g.columnIndex === col.index);
                      return (
                        <tr key={col.index} className="border-t border-line align-top">
                          <td className="px-2 py-2 font-medium">{col.name}</td>
                          <td className="max-w-64 px-2 py-2 text-[13px] text-muted">
                            {col.samples.map(cellText).join(' ｜ ') || '（全是空的）'}
                          </td>
                          <td className="px-2 py-2">
                            <Select
                              aria-label={`${s.name} · ${col.name} 导入到`}
                              value={encode(m)}
                              onChange={(e) =>
                                setMapping(col.index, e.target.value, col.name, col.customKey)
                              }
                            >
                              <option value="ignore">忽略这一列</option>
                              <optgroup label="系统字段">
                                {target.fields.map((f) => (
                                  <option
                                    key={f.key}
                                    value={`f:${f.key}`}
                                    disabled={used.has(f.key) && used.get(f.key) !== col.index}
                                  >
                                    {f.label}
                                    {f.required ? ' *' : ''}
                                    {used.has(f.key) && used.get(f.key) !== col.index
                                      ? '（已被别的列使用）'
                                      : ''}
                                  </option>
                                ))}
                              </optgroup>
                              <optgroup label="其他">
                                {target.canCustom && (
                                  <option value="custom">新建自定义字段…</option>
                                )}
                                <option value="raw">存为原始值</option>
                              </optgroup>
                            </Select>
                            {aiCols[s.name]?.includes(col.index) && (
                              <div className="mt-1">
                                <Badge tone="orange">AI 建议，请确认</Badge>
                              </div>
                            )}
                            {field?.hint && (
                              <div className="mt-1 text-xs text-muted">{field.hint}</div>
                            )}
                            {m &&
                              m.kind === 'field' &&
                              sug?.mapping.kind === 'field' &&
                              sug.mapping.field === m.field &&
                              sug.confidence > 0 &&
                              sug.confidence < 1 && (
                                <div className="mt-1">
                                  <Badge tone="orange">自动识别，请确认</Badge>
                                </div>
                              )}
                            {m?.kind === 'custom' && (
                              <div className="mt-2 flex gap-2">
                                <TextInput
                                  aria-label="自定义字段名称"
                                  value={m.label}
                                  onChange={(e) =>
                                    patchMapping(col.index, { label: e.target.value })
                                  }
                                />
                                <Select
                                  aria-label="自定义字段类型"
                                  className="!w-28"
                                  value={m.type}
                                  onChange={(e) =>
                                    patchMapping(col.index, { type: e.target.value as CustomType })
                                  }
                                >
                                  {(Object.keys(CUSTOM_TYPE_LABEL) as CustomType[]).map((t) => (
                                    <option key={t} value={t}>
                                      {CUSTOM_TYPE_LABEL[t]}
                                    </option>
                                  ))}
                                </Select>
                              </div>
                            )}
                            {m?.kind === 'raw' && (
                              <div className="mt-1 text-xs text-muted">
                                原样保存到「导入原始值」，不做转换
                              </div>
                            )}
                          </td>
                          <td className="px-2 py-2">
                            {field && !field.enum ? (
                              <Select
                                aria-label={`${s.name} · ${col.name} 值转换`}
                                value={(m as { transform?: string }).transform ?? field.transform}
                                onChange={(e) =>
                                  patchMapping(col.index, {
                                    transform:
                                      e.target.value === field.transform
                                        ? undefined
                                        : e.target.value,
                                  } as Partial<ColumnMapping>)
                                }
                              >
                                {Object.entries(meta.transforms).map(([k, label]) => (
                                  <option key={k} value={k}>
                                    {label}
                                    {k === field.transform ? '（默认）' : ''}
                                  </option>
                                ))}
                              </Select>
                            ) : field?.enum ? (
                              <span className="text-[13px] text-muted">
                                枚举值，下一步对应系统选项
                              </span>
                            ) : (
                              <span className="text-muted">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          );
        })}
    </div>
  );
}

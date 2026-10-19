import { useRef, useState } from 'react';
import { api } from '../../lib/api.ts';
import { Badge, Button, Field, Select, TextInput, useToast } from '../ui.tsx';
import {
  cellText,
  initialState,
  type Meta,
  type SheetAnalysis,
  type SheetState,
  type TargetKey,
} from './shared.ts';

export interface UploadResult {
  sessionId: string;
  fileName: string;
  encoding: 'utf-8' | 'gbk' | null;
  sheets: SheetAnalysis[];
}

/** 第 1 步：上传文件 */
export function UploadStep({ onUploaded }: { onUploaded: (r: UploadResult) => void }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);

  async function send(file: File) {
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/import/upload', { method: 'POST', body: form });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? '上传失败');
      onUploaded(data as UploadResult);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const f = e.dataTransfer.files[0];
          if (f) void send(f);
        }}
        className={`flex flex-col items-center gap-3 rounded-xl border-2 border-dashed px-6 py-12 text-center ${over ? 'border-brand bg-brand-soft' : 'border-line-strong bg-surface'}`}
      >
        <div className="text-base font-medium">把 Excel 或 CSV 文件拖到这里</div>
        <div className="text-muted">
          支持 .xlsx、.xls、.csv；CSV 自动识别 GBK 和 UTF-8 编码；最大 30 MB
        </div>
        <Button variant="primary" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? '正在解析…' : '选择文件'}
        </Button>
        <input
          ref={input}
          type="file"
          accept=".xlsx,.xls,.csv"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void send(f);
          }}
        />
      </div>
      <p className="m-0 text-muted">
        没有现成的表？
        <a href="/api/import/sample.xlsx" download>
          下载样例文件
        </a>
        （虚构的钉钉多维表导出，包含各种常见写法和错误行）试一遍整个流程。
      </p>
    </div>
  );
}

/** 第 2 步：选 sheet、选目标、确认表头行 */
export function SheetsStep({
  sessionId,
  sheets,
  setSheets,
  meta,
}: {
  sessionId: string;
  sheets: SheetState[];
  setSheets: (s: SheetState[]) => void;
  meta: Meta;
}) {
  const toast = useToast();
  const replace = (name: string, fn: (s: SheetState) => SheetState) =>
    setSheets(sheets.map((s) => (s.name === name ? fn(s) : s)));

  async function reanalyze(
    s: SheetState,
    header: { row: number; rows: number },
    target?: TargetKey,
  ) {
    try {
      const a = await api<SheetAnalysis>('POST', `/import/${sessionId}/analyze`, {
        sheet: s.name,
        headerRow: header.row,
        headerRows: header.rows,
        target,
      });
      // 换了表头或目标：列映射按新的建议重来；模板只在没有手动改动时才套用
      const tpl =
        a.template && a.template.applied.target === (target ?? a.target) ? a.template : null;
      const fresh = initialState({ ...a, target: target ?? a.target, template: tpl });
      replace(s.name, () => ({ ...fresh, include: s.include }));
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 text-muted">
        勾选要导入的
        sheet，确认每张表导入成什么，以及表头在第几行。系统已经按表头文字做了推荐，不对的地方在这里改。
      </p>
      {sheets.map((s) => (
        <section
          key={s.name}
          className={`rounded-xl border bg-surface p-4 ${s.include ? 'border-brand' : 'border-line'}`}
        >
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex cursor-pointer items-center gap-2 text-base font-bold">
              <input
                type="checkbox"
                checked={s.include}
                onChange={(e) => replace(s.name, (x) => ({ ...x, include: e.target.checked }))}
              />
              {s.name}
            </label>
            <Badge>{s.rowCount} 行数据</Badge>
            {s.mergedCells > 0 && (
              <Badge tone="gray">含 {s.mergedCells} 处合并单元格（已展开）</Badge>
            )}
            {s.template && (
              <Badge tone="green">
                套用了模板「{s.template.name}」· 相似度 {Math.round(s.template.score * 100)}%
              </Badge>
            )}
          </div>
          {s.template && (s.template.added.length > 0 || s.template.missing.length > 0) && (
            <p className="mb-0 mt-2 text-[13px] text-warn">
              {s.template.added.length > 0 && (
                <>这次表里新增的列：{s.template.added.join('、')}（请在下一步指定怎么处理）。</>
              )}
              {s.template.missing.length > 0 && (
                <>模板里有、这次没有的列：{s.template.missing.join('、')}。</>
              )}
            </p>
          )}
          {s.include && (
            <>
              <div className="mt-3 grid grid-cols-[minmax(160px,220px)_auto] items-end gap-4">
                <Field label="导入成" hint={`推荐：${meta.targets[s.target].label}`}>
                  <Select
                    aria-label={`${s.name} 导入成`}
                    value={s.target}
                    onChange={(e) => reanalyze(s, s.header, e.target.value as TargetKey)}
                  >
                    {(Object.keys(meta.targets) as TargetKey[]).map((t) => (
                      <option key={t} value={t}>
                        {meta.targets[t].label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <div className="flex flex-wrap items-end gap-2">
                  <Field label="表头从第几行开始">
                    <HeaderNumber
                      label={`${s.name} 表头起始行`}
                      value={s.header.row + 1}
                      min={1}
                      onCommit={(v) => reanalyze(s, { row: v - 1, rows: s.header.rows }, s.target)}
                    />
                  </Field>
                  <Field label="表头占几行" hint="两行表头会合成“分组/列名”">
                    <HeaderNumber
                      label={`${s.name} 表头行数`}
                      value={s.header.rows}
                      min={1}
                      max={4}
                      onCommit={(v) => reanalyze(s, { row: s.header.row, rows: v }, s.target)}
                    />
                  </Field>
                </div>
              </div>
              <PreviewTable s={s} />
            </>
          )}
        </section>
      ))}
    </div>
  );
}

/** 失去焦点或回车时才提交，避免每敲一个字就重新分析 */
function HeaderNumber({
  value,
  min,
  max,
  onCommit,
  label,
}: {
  value: number;
  min: number;
  max?: number;
  onCommit: (v: number) => void;
  label: string;
}) {
  const [text, setText] = useState(String(value));
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setText(String(value));
  }
  const commit = () => {
    const n = Number(text);
    if (Number.isInteger(n) && n >= min && (max === undefined || n <= max) && n !== value)
      onCommit(n);
    else setText(String(value));
  };
  return (
    <TextInput
      aria-label={label}
      className="!w-24"
      inputMode="numeric"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
    />
  );
}

function PreviewTable({ s }: { s: SheetState }) {
  const width = Math.max(...s.preview.map((r) => r.length), 0);
  return (
    <div className="mt-3 overflow-x-auto rounded-lg border border-line">
      <table className="w-full border-collapse text-left text-[13px]">
        <tbody>
          {s.preview.map((row, i) => {
            const isHeader = i >= s.header.row && i < s.header.row + s.header.rows;
            return (
              <tr
                key={i}
                className={`border-b border-line last:border-0 ${isHeader ? 'bg-brand-soft font-medium' : i < s.header.row ? 'text-muted' : ''}`}
              >
                <td className="w-10 px-2 py-1 text-right text-muted">{i + 1}</td>
                {Array.from({ length: width }, (_, c) => (
                  <td key={c} className="max-w-48 truncate px-2 py-1" title={cellText(row[c])}>
                    {cellText(row[c])}
                  </td>
                ))}
                <td className="px-2 py-1 text-xs text-brand">{isHeader ? '表头' : ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {s.rowCount > s.preview.length && (
        <div className="px-2 py-1 text-xs text-muted">
          只显示前 {s.preview.length} 行，共 {s.rowCount + s.header.row + s.header.rows} 行
        </div>
      )}
    </div>
  );
}

import { useState } from 'react';
import { api } from '../../lib/api.ts';
import { useAction } from '../detail.tsx';
import { Badge, Button, Card, TextInput } from '../ui.tsx';
import type { DrySheet } from './PreviewStep.tsx';
import { toConfigs, type Decisions, type Meta, type SheetState } from './shared.ts';

export interface CommitResult {
  batchId: string;
  sheets: {
    sheet: string;
    target: string;
    created: number;
    updated: number;
    skipped: number;
    failed: number;
    pendingReview: number;
    errors: { rowNo: number; text: string }[];
  }[];
}

/** 第 5 步：确认并提交，成功后显示结果；可顺带保存模板 */
export function CommitStep({
  sessionId,
  fileName,
  sheets,
  decisions,
  dry,
  meta,
  onGoBatches,
  onRestart,
}: {
  sessionId: string;
  fileName: string;
  sheets: SheetState[];
  decisions: Decisions;
  dry: DrySheet[] | undefined;
  meta: Meta;
  onGoBatches: () => void;
  onRestart: () => void;
}) {
  const run = useAction();
  const [saveTpl, setSaveTpl] = useState(true);
  const [tplName, setTplName] = useState(fileName.replace(/\.[^.]+$/, ''));
  const [result, setResult] = useState<CommitResult | null>(null);
  const [busy, setBusy] = useState(false);

  if (result) {
    return (
      <div className="flex flex-col gap-4">
        <Card title="导入完成">
          <p className="mt-0">
            已作为一个导入批次写入。如果发现导错了，可以到「导入批次」里整批回滚。
          </p>
          {result.sheets.map((s) => (
            <div key={s.sheet} className="border-t border-line py-3">
              <b>{s.sheet}</b>{' '}
              <span className="text-muted">
                → {meta.targets[s.target as keyof Meta['targets']].label}
              </span>
              <div className="mt-1 flex flex-wrap gap-2">
                <Badge tone="green">新增 {s.created}</Badge>
                <Badge>更新 {s.updated}</Badge>
                <Badge>跳过 / 无变化 {s.skipped}</Badge>
                {s.pendingReview > 0 && <Badge tone="orange">{s.pendingReview} 条进了审核</Badge>}
                {s.failed > 0 && <Badge tone="red">失败 {s.failed}</Badge>}
              </div>
              {s.errors.length > 0 && (
                <ul className="mb-0 mt-2 list-none p-0 text-[13px] text-red-700">
                  {s.errors.slice(0, 10).map((e) => (
                    <li key={e.rowNo}>
                      第 {e.rowNo} 行：{e.text}
                    </li>
                  ))}
                  {s.errors.length > 10 && (
                    <li className="text-muted">… 另有 {s.errors.length - 10} 行</li>
                  )}
                </ul>
              )}
            </div>
          ))}
          {result.sheets.some((s) => s.pendingReview > 0) && (
            <p className="mb-0 text-[13px] text-muted">
              进了审核的是对已有记录的金额、佣金等敏感字段的改动，到「审核」页确认后才会生效。
            </p>
          )}
        </Card>
        <div className="flex gap-2">
          <Button variant="primary" onClick={onGoBatches}>
            查看导入批次
          </Button>
          <Button onClick={onRestart}>再导入一个文件</Button>
        </div>
      </div>
    );
  }

  const blockers: string[] = [];
  for (const d of dry ?? []) {
    if (d.configIssues.length) blockers.push(`「${d.sheet}」列映射有问题：${d.configIssues[0]}`);
    if (d.unmappedEnums)
      blockers.push(`「${d.sheet}」还有 ${d.unmappedEnums} 个枚举值没有对应的系统选项`);
    if (d.undecided) blockers.push(`「${d.sheet}」还有 ${d.undecided} 条疑似重复没有裁决`);
  }
  const importable = (dry ?? []).reduce(
    (n, d) =>
      n +
      d.stats.new +
      d.stats.update +
      d.rows.filter((r) => r.status === 'duplicate' && r.decision && r.decision !== 'skip').length,
    0,
  );
  if (dry && importable === 0) blockers.push('没有可以导入的行');

  async function commit() {
    setBusy(true);
    const res = await run(
      () =>
        api<CommitResult>('POST', `/import/${sessionId}/commit`, {
          configs: toConfigs(sheets),
          decisions,
          saveTemplate: saveTpl && tplName.trim() ? { name: tplName.trim() } : undefined,
        }),
      '导入完成',
    );
    setBusy(false);
    if (res) setResult(res);
  }

  return (
    <div className="flex flex-col gap-4">
      <Card title="确认导入">
        {(dry ?? []).map((d) => (
          <div
            key={d.sheet}
            className="flex flex-wrap items-center gap-2 border-t border-line py-2.5 first:border-0"
          >
            <b className="min-w-28">{d.sheet}</b>
            <span className="text-muted">
              → {meta.targets[d.target as keyof Meta['targets']].label}
            </span>
            <Badge tone="green">新增 {d.stats.new}</Badge>
            <Badge>更新 {d.stats.update}</Badge>
            {d.stats.duplicate > 0 && <Badge tone="orange">疑似重复 {d.stats.duplicate}</Badge>}
            {d.stats.warning > 0 && <Badge tone="orange">警告 {d.stats.warning}</Badge>}
            {d.stats.error > 0 && <Badge tone="red">错误 {d.stats.error}（不导入）</Badge>}
          </div>
        ))}
        {blockers.length > 0 && (
          <div
            className="mt-3 rounded-lg border border-warn bg-orange-50 px-3 py-2 text-warn"
            role="alert"
          >
            <b>还不能提交：</b>
            {blockers.map((b) => (
              <div key={b}>{b}</div>
            ))}
            <div className="text-[13px]">回到上一步处理后再来。</div>
          </div>
        )}
      </Card>
      <Card title="保存为模板（可选）">
        <label className="flex cursor-pointer items-center gap-2">
          <input type="checkbox" checked={saveTpl} onChange={(e) => setSaveTpl(e.target.checked)} />
          保存这次的列映射、值转换和枚举对应，下次上传同样格式的表会自动套用
        </label>
        {saveTpl && (
          <div className="mt-2 max-w-sm">
            <TextInput
              aria-label="模板名称"
              value={tplName}
              onChange={(e) => setTplName(e.target.value)}
              placeholder="模板名称"
            />
          </div>
        )}
      </Card>
      <div>
        <Button variant="primary" disabled={busy || blockers.length > 0 || !dry} onClick={commit}>
          {busy ? '正在导入…' : `确认导入 ${importable} 行`}
        </Button>
      </div>
    </div>
  );
}

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../lib/api.ts';
import { fmtDate } from '../../lib/format.ts';
import { patchEntity, useAction } from '../detail.tsx';
import { Badge, Button, Card, ConfirmDialog, Empty, Select, TextInput } from '../ui.tsx';
import type { ColumnMapping, Meta, TargetKey } from './shared.ts';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const encode = (m: ColumnMapping | undefined) =>
  !m || m.kind === 'ignore'
    ? 'ignore'
    : m.kind === 'field'
      ? `f:${m.field}`
      : m.kind === 'custom'
        ? 'custom'
        : 'raw';

/** 设置页：导入模板的查看、改名、改列映射、删除（PRD 6.3） */
export function TemplatesCard() {
  const meta = useQuery({
    queryKey: ['import-meta'],
    queryFn: () => api<Meta>('GET', '/import/meta'),
    staleTime: 60_000,
  });
  const list = useQuery({
    queryKey: ['templates'],
    queryFn: () => api<{ rows: Row[] }>('GET', '/e/mapping_template'),
  });
  const rows = list.data?.rows ?? [];
  return (
    <Card title="导入模板">
      <p className="mt-0 text-muted">
        导入时勾选「保存为模板」会存在这里：按表头文字记下每一列对应的字段、值转换和枚举对应；下次上传表头相似的表会自动套用。
      </p>
      {rows.length === 0 && <Empty>还没有模板。第一次导入提交时选择保存，就会出现在这里。</Empty>}
      <div className="flex flex-col gap-2">
        {meta.data && rows.map((t) => <TemplateRow key={t.id} t={t} meta={meta.data} />)}
      </div>
    </Card>
  );
}

function TemplateRow({ t, meta }: { t: Row; meta: Meta }) {
  const run = useAction();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(t.name as string);
  const [confirm, setConfirm] = useState(false);
  const target = meta.targets[t.entity as TargetKey];
  const body = t.mapping as { headerRows: number; byHeader: Record<string, ColumnMapping> };
  const headers: string[] = t.headerSignature;
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[（(][^）)]*[）)]/g, '')
      .replace(/[\s_\-:：*＊/\\·.]+/g, '');

  const setMapping = (header: string, value: string) => {
    const key = norm(header);
    const byHeader = { ...body.byHeader };
    if (value === 'ignore') delete byHeader[key];
    else if (value === 'raw') byHeader[key] = { kind: 'raw' };
    else if (value.startsWith('f:')) {
      const field = value.slice(2);
      for (const [k, m] of Object.entries(byHeader))
        if (m.kind === 'field' && m.field === field) delete byHeader[k];
      byHeader[key] = { kind: 'field', field };
    }
    return run(
      () => patchEntity('mapping_template', t.id, { mapping: { ...body, byHeader } }, t.version),
      '模板已更新',
    );
  };

  return (
    <div className="rounded-lg border border-line px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          <b>{t.name}</b> <Badge>{target?.label ?? t.entity}</Badge>{' '}
          <span className="text-[13px] text-muted">
            {headers.length} 列 · {fmtDate(t.createdAt)}
          </span>
        </span>
        <span className="flex gap-1">
          <Button variant="ghost" onClick={() => setOpen(!open)}>
            {open ? '收起' : '查看 / 修改'}
          </Button>
          <Button variant="ghost" onClick={() => setConfirm(true)}>
            删除
          </Button>
        </span>
      </div>
      {open && target && (
        <div className="mt-3">
          <div className="mb-3 flex max-w-md gap-2">
            <TextInput
              aria-label="模板名称"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Button
              disabled={!name.trim() || name === t.name}
              onClick={() =>
                run(
                  () => patchEntity('mapping_template', t.id, { name: name.trim() }, t.version),
                  '已改名',
                )
              }
            >
              改名
            </Button>
          </div>
          <table className="w-full max-w-2xl border-collapse text-left text-[13px]">
            <thead>
              <tr className="text-muted">
                <th className="py-1 pr-3 font-medium">表头</th>
                <th className="py-1 font-medium">导入到</th>
              </tr>
            </thead>
            <tbody>
              {headers.map((h) => {
                const m = body.byHeader[norm(h)];
                return (
                  <tr key={h} className="border-t border-line">
                    <td className="py-1.5 pr-3">{h}</td>
                    <td className="py-1.5">
                      {m?.kind === 'custom' ? (
                        <span>
                          自定义字段「{m.label}」（{m.type}）
                        </span>
                      ) : (
                        <Select
                          aria-label={`${t.name} · ${h}`}
                          className="!w-56"
                          value={encode(m)}
                          onChange={(e) => setMapping(h, e.target.value)}
                        >
                          <option value="ignore">忽略</option>
                          <optgroup label="系统字段">
                            {target.fields.map((f) => (
                              <option key={f.key} value={`f:${f.key}`}>
                                {f.label}
                              </option>
                            ))}
                          </optgroup>
                          <option value="raw">存为原始值</option>
                        </Select>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {confirm && (
        <ConfirmDialog
          title="删除模板"
          danger
          confirmLabel="删除"
          message={`确定删除模板「${t.name}」？已经导入的数据不受影响。`}
          onClose={() => setConfirm(false)}
          onConfirm={() => run(() => api('DELETE', `/e/mapping_template/${t.id}`), '已删除')}
        />
      )}
    </div>
  );
}

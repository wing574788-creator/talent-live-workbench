import { fieldLabel, fmtValue } from '../lib/labels.ts';

export interface FieldDiff {
  field: string;
  before: unknown;
  after: unknown;
  current?: unknown;
}

/** 改动前后对比：旧值划线、新值高亮；记录现在的值和提出时不同（冲突）时单独标出 */
export function DiffTable({ diff }: { diff: FieldDiff[] }) {
  if (!diff.length) return null;
  return (
    <table className="mt-2 w-full border-collapse text-left text-[13px]">
      <thead>
        <tr className="text-muted">
          <th className="w-32 py-1 pr-2 font-medium">字段</th>
          <th className="py-1 pr-2 font-medium">改动前</th>
          <th className="py-1 font-medium">改动后</th>
        </tr>
      </thead>
      <tbody>
        {diff.map((d) => (
          <tr key={d.field} className="border-t border-line align-top">
            <td className="py-1.5 pr-2 text-muted">{fieldLabel(d.field)}</td>
            <td className="py-1.5 pr-2 text-muted line-through decoration-line-strong">
              {fmtValue(d.field, d.before)}
            </td>
            <td className="py-1.5">
              <span className="rounded bg-brand-soft px-1.5 py-0.5 font-medium text-brand">
                {fmtValue(d.field, d.after)}
              </span>
              {d.current !== undefined && (
                <div className="mt-1 text-warn">
                  现在的值：{fmtValue(d.field, d.current)}（已被修改）
                </div>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

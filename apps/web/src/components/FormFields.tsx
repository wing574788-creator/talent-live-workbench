import { useState, type ReactNode } from 'react';
import { yuanToCents } from '../lib/format.ts';
import { Button, Field, Select, TextInput, Textarea } from './ui.tsx';

export type FieldType =
  'text' | 'textarea' | 'number' | 'money' | 'percent' | 'date' | 'select' | 'tags' | 'bool';

export interface FieldSpec {
  key: string;
  label: string;
  type: FieldType;
  options?: string[];
  required?: boolean;
  /** 自定义字段：值存在 row.custom[key] */
  custom?: boolean;
  /** 敏感字段：列表里是打码值，未点"查看"前不可编辑 */
  sensitive?: boolean;
  placeholder?: string;
  wide?: boolean;
}

type Form = Record<string, string>;

const read = (row: Record<string, any> | undefined, s: FieldSpec) =>
  // eslint-disable-line @typescript-eslint/no-explicit-any
  s.custom ? row?.custom?.[s.key] : row?.[s.key];

export function toForm(row: Record<string, any> | undefined, specs: FieldSpec[]): Form {
  // eslint-disable-line @typescript-eslint/no-explicit-any
  const f: Form = {};
  for (const s of specs) {
    const v = read(row, s);
    if (v == null) f[s.key] = s.type === 'bool' ? '' : '';
    else if (s.type === 'money') f[s.key] = String(v / 100);
    else if (s.type === 'tags') f[s.key] = (v as string[]).join('，');
    else f[s.key] = String(v);
  }
  return f;
}

/** 表单字符串 → 带类型的 payload；校验失败抛出带字段名的错误。 */
export function fromForm(form: Form, specs: FieldSpec[], skip: Set<string> = new Set()) {
  const out: Record<string, unknown> = {};
  const custom: Record<string, unknown> = {};
  for (const s of specs) {
    if (skip.has(s.key)) continue;
    const raw = (form[s.key] ?? '').trim();
    if (s.required && !raw) throw new Error(`请填写「${s.label}」`);
    let v: unknown = null;
    if (raw) {
      switch (s.type) {
        case 'money': {
          const c = yuanToCents(raw);
          if (c === null || Number.isNaN(c)) throw new Error(`「${s.label}」不是有效金额`);
          v = c;
          break;
        }
        case 'number':
        case 'percent':
          v = Number(raw);
          if (!Number.isFinite(v)) throw new Error(`「${s.label}」应为数字`);
          break;
        case 'tags':
          v = raw.split(/[,，、\s]+/).filter(Boolean);
          break;
        case 'bool':
          v = raw === 'true';
          break;
        default:
          v = raw;
      }
    } else if (s.type === 'tags') v = [];
    if (s.custom) custom[s.key] = v;
    else out[s.key] = v;
  }
  if (Object.keys(custom).length) out.custom = custom;
  return out;
}

function Input({
  s,
  value,
  onChange,
  disabled,
}: {
  s: FieldSpec;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const common = {
    value,
    disabled,
    onChange: (e: { target: { value: string } }) => onChange(e.target.value),
  };
  switch (s.type) {
    case 'textarea':
      return <Textarea rows={3} {...common} placeholder={s.placeholder} />;
    case 'select':
      return (
        <Select {...common}>
          <option value="">{s.required ? '请选择' : '—'}</option>
          {s.options?.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </Select>
      );
    case 'bool':
      return (
        <Select {...common}>
          <option value="">—</option>
          <option value="true">是</option>
          <option value="false">否</option>
        </Select>
      );
    case 'date':
      return <TextInput type="date" {...common} />;
    case 'money':
      return <TextInput inputMode="decimal" placeholder="元，如 1299.00" {...common} />;
    case 'percent':
    case 'number':
      return (
        <TextInput
          inputMode="decimal"
          {...common}
          placeholder={s.type === 'percent' ? '如 20 表示 20%' : s.placeholder}
        />
      );
    case 'tags':
      return <TextInput {...common} placeholder="用逗号分隔" />;
    default:
      return <TextInput {...common} placeholder={s.placeholder} />;
  }
}

export function FormGrid({
  specs,
  form,
  setForm,
  locked,
}: {
  specs: FieldSpec[];
  form: Form;
  setForm: (f: Form) => void;
  locked?: Set<string>;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {specs.map((s) => (
        <div key={s.key} className={s.wide || s.type === 'textarea' ? 'col-span-2' : ''}>
          <Field
            label={s.label + (s.required ? ' *' : '')}
            hint={locked?.has(s.key) ? '点击上方「查看敏感信息」后才能编辑' : undefined}
          >
            <Input
              s={s}
              value={form[s.key] ?? ''}
              disabled={locked?.has(s.key)}
              onChange={(v) => setForm({ ...form, [s.key]: v })}
            />
          </Field>
        </div>
      ))}
    </div>
  );
}

/** 详情页里的"查看 / 编辑"卡片 */
export function EditableFields({
  specs,
  row,
  display,
  onSave,
  locked,
  extra,
}: {
  specs: FieldSpec[];
  row: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** 自定义展示（如打码字段、金额格式化） */
  display?: (s: FieldSpec, value: unknown) => ReactNode;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
  locked?: Set<string>;
  extra?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Form>({});
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  if (!editing) {
    return (
      <div>
        <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-3">
          {specs.map((s) => {
            const v = read(row, s);
            return (
              <div key={s.key} className={s.wide || s.type === 'textarea' ? 'col-span-2' : ''}>
                <dt className="text-[13px] text-muted">{s.label}</dt>
                <dd className="m-0 whitespace-pre-wrap break-words">
                  {display?.(s, v) ??
                    (v == null || v === '' ? (
                      <span className="text-muted">—</span>
                    ) : Array.isArray(v) ? (
                      v.join('、')
                    ) : s.type === 'bool' ? (
                      v ? (
                        '是'
                      ) : (
                        '否'
                      )
                    ) : (
                      String(v)
                    ))}
                </dd>
              </div>
            );
          })}
        </dl>
        <div className="mt-4 flex gap-2">
          <Button
            onClick={() => {
              setForm(toForm(row, specs));
              setErr('');
              setEditing(true);
            }}
          >
            编辑
          </Button>
          {extra}
        </div>
      </div>
    );
  }
  return (
    <div>
      <FormGrid specs={specs} form={form} setForm={setForm} locked={locked} />
      {err && <p className="mb-0 mt-3 text-warn">{err}</p>}
      <div className="mt-4 flex gap-2">
        <Button
          variant="primary"
          disabled={busy}
          onClick={async () => {
            try {
              const patch = fromForm(form, specs, locked);
              setBusy(true);
              await onSave(patch);
              setEditing(false);
            } catch (e) {
              setErr((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          保存
        </Button>
        <Button onClick={() => setEditing(false)}>取消</Button>
      </div>
    </div>
  );
}

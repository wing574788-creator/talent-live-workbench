import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';

export const cx = (...a: (string | false | undefined)[]) => a.filter(Boolean).join(' ');

const BTN = {
  primary: 'bg-brand text-white hover:bg-brand-dark border-transparent',
  secondary: 'bg-surface text-ink border-line-strong hover:bg-bg',
  danger: 'bg-surface text-warn border-warn hover:bg-warn-soft',
  ghost: 'bg-transparent text-brand border-transparent hover:bg-brand-soft',
};

export function Button({
  variant = 'secondary',
  className,
  ...p
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof BTN }) {
  return (
    <button
      type="button"
      {...p}
      className={cx(
        'min-h-9 cursor-pointer whitespace-nowrap rounded-xl border px-4 text-sm font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        BTN[variant],
        className,
      )}
    />
  );
}

const inputCls =
  'min-h-10 w-full rounded-xl border border-line-strong bg-surface px-3 text-sm disabled:bg-bg disabled:text-muted';

export const TextInput = (p: InputHTMLAttributes<HTMLInputElement>) => (
  <input {...p} className={cx(inputCls, p.className)} />
);
export const Textarea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea {...p} className={cx(inputCls, 'py-2', p.className)} />
);
export const Select = (p: SelectHTMLAttributes<HTMLSelectElement>) => (
  <select {...p} className={cx(inputCls, p.className)} />
);

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[13px] text-muted">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function Card({
  title,
  actions,
  children,
}: {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-[28px] bg-surface px-6 py-5 shadow-[0_1px_0_var(--color-line)]">
      {(title || actions) && (
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="m-0 text-lg font-extrabold">{title}</h3>
          <div className="flex gap-2">{actions}</div>
        </div>
      )}
      {children}
    </section>
  );
}

export function Badge({
  children,
  tone = 'gray',
}: {
  children: ReactNode;
  tone?: 'gray' | 'green' | 'orange' | 'red';
}) {
  const t = {
    gray: 'bg-bg text-muted',
    green: 'bg-brand-soft text-brand-dark',
    orange: 'bg-amber-soft text-[#8a4b00]',
    red: 'bg-warn-soft text-warn',
  }[tone];
  return (
    <span className={cx('inline-block rounded-full px-2.5 py-0.5 text-xs font-bold', t)}>
      {children}
    </span>
  );
}

export function Tabs({
  tabs,
  value,
  onChange,
}: {
  tabs: string[];
  value: string;
  onChange: (t: string) => void;
}) {
  return (
    <div className="flex w-fit max-w-full gap-1 overflow-x-auto rounded-2xl bg-surface p-1 shadow-[0_1px_0_var(--color-line)]">
      {tabs.map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => onChange(t)}
          className={cx(
            'min-h-9 cursor-pointer whitespace-nowrap rounded-xl border-0 px-4 text-sm transition-colors',
            t === value
              ? 'bg-ink font-bold text-white'
              : 'bg-transparent font-medium text-ink-2 hover:bg-bg',
          )}
        >
          {t}
        </button>
      ))}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-6 text-center text-muted">{children}</div>;
}

// ───────────── 抽屉 / 对话框 ─────────────
export function Drawer({
  title,
  onClose,
  children,
  width = 640,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-ink/35 backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <aside
        className="flex h-full max-w-full flex-col rounded-l-[32px] bg-bg shadow-2xl"
        style={{ width }}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="详情"
      >
        <header className="flex items-center justify-between gap-3 px-6 pb-2 pt-5">
          <h2 className="m-0 text-2xl font-extrabold tracking-tight">{title}</h2>
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
        </header>
        <div className="flex-1 overflow-y-auto px-6 pb-6 pt-3">{children}</div>
      </aside>
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  width = 560,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full flex-col rounded-3xl bg-surface shadow-xl"
        style={{ maxWidth: width }}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={title}
      >
        <header className="border-b border-line px-5 py-3 text-base font-bold">{title}</header>
        <div className="flex-1 overflow-y-auto px-6 pb-6 pt-3">{children}</div>
        {footer && (
          <footer className="flex justify-end gap-2 border-t border-line px-5 py-3">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = '确认',
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      width={440}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {message}
    </Modal>
  );
}

// ───────────── Toast ─────────────
type ToastKind = 'ok' | 'error';
const ToastCtx = createContext<(msg: string, kind?: ToastKind) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<{ id: number; msg: string; kind: ToastKind }[]>([]);
  const push = useCallback((msg: string, kind: ToastKind = 'ok') => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, msg, kind }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div
        className="fixed bottom-6 left-1/2 z-[60] flex -translate-x-1/2 flex-col gap-2"
        aria-live="polite"
      >
        {items.map((i) => (
          <div
            key={i.id}
            className={cx(
              'rounded-lg px-4 py-2 text-sm text-white shadow-lg',
              i.kind === 'error' ? 'bg-warn' : 'bg-ink',
            )}
          >
            {i.msg}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ───────────── 视觉共用件（现代年轻风格） ─────────────
const AVATAR_COLORS = [
  ['#ffd3c9', '#8a2b16'],
  ['#cff5e7', '#0b6b4f'],
  ['#d9d5ff', '#3730a3'],
  ['#ffe9c7', '#8a4b00'],
];

/** 圆形头像：取名字的第一个字，按名字固定配色（同一个人在哪都是同一个颜色） */
export function Avatar({ name, size = 36 }: { name: string; size?: number }) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % AVATAR_COLORS.length;
  const [bg, fg] = AVATAR_COLORS[h]!;
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center rounded-full font-extrabold"
      style={{
        width: size,
        height: size,
        background: bg,
        color: fg,
        fontSize: Math.round(size * 0.4),
      }}
    >
      {name.replace(/^示例达人/, '').slice(0, 1)}
    </span>
  );
}

/** 药丸形的分段切换（筛选标签、视图切换） */
export function PillTabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: { key: T; label: string; count?: number }[];
  value: T;
  onChange: (k: T) => void;
  label: string;
}) {
  return (
    <div className="flex flex-wrap gap-2" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button
          key={t.key || 'all'}
          type="button"
          role="tab"
          aria-selected={value === t.key}
          onClick={() => onChange(t.key)}
          className={cx(
            'min-h-9 cursor-pointer rounded-full border px-4 text-sm transition-colors',
            value === t.key
              ? 'border-transparent bg-brand-soft font-extrabold text-brand-dark'
              : 'border-line bg-surface font-medium text-ink-2 hover:bg-bg',
          )}
        >
          {t.label}
          {t.count != null && <span className="ml-1.5 text-xs text-muted">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** 页面标题：大标题 + 一行说明 + 右侧操作 */
export function PageHeader({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="m-0 text-3xl font-extrabold tracking-tight">{title}</h1>
        {hint && <div className="mt-1 text-sm text-muted">{hint}</div>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2.5">{children}</div>}
    </div>
  );
}

/** 表格外框、表头、行、单元格的统一样式 */
export const TABLE = {
  wrap: 'overflow-x-auto rounded-[28px] bg-surface shadow-[0_1px_0_var(--color-line)]',
  headRow: 'border-b border-line',
  th: 'whitespace-nowrap px-4 py-3.5 text-[13px] font-bold text-muted',
  row: 'cursor-pointer border-b border-line transition-colors last:border-0 hover:bg-[#f8f7fd]',
  td: 'px-4 py-3.5 align-top',
};

const PLATFORM_TONE: Record<string, string> = {
  抖音: 'bg-ink text-white',
  小红书: 'bg-warn-soft text-warn',
  视频号: 'bg-mint-soft text-[#0b6b4f]',
};
/** 平台标签：每个平台一个颜色，列表里一眼能分出来 */
export function PlatformTag({ platform }: { platform: string }) {
  return (
    <span
      className={cx(
        'inline-block rounded-full px-2.5 py-0.5 text-xs font-bold',
        PLATFORM_TONE[platform] ?? 'bg-bg text-muted',
      )}
    >
      {platform}
    </span>
  );
}

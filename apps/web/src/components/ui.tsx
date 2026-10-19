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
  secondary: 'bg-surface text-ink-2 border-line-strong hover:bg-bg',
  danger: 'bg-surface text-warn border-warn hover:bg-red-50',
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
        'min-h-9 cursor-pointer whitespace-nowrap rounded-lg border px-3.5 text-sm disabled:cursor-not-allowed disabled:opacity-50',
        BTN[variant],
        className,
      )}
    />
  );
}

const inputCls =
  'min-h-9 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm disabled:bg-bg disabled:text-muted';

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
    <section className="rounded-xl border border-line bg-surface px-5 py-4">
      {(title || actions) && (
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="m-0 text-[15px] font-bold">{title}</h3>
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
    green: 'bg-brand-soft text-brand',
    orange: 'bg-orange-50 text-warn',
    red: 'bg-red-50 text-red-700',
  }[tone];
  return <span className={cx('inline-block rounded-md px-2 py-0.5 text-xs', t)}>{children}</span>;
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
    <div className="flex gap-1 overflow-x-auto border-b border-line">
      {tabs.map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => onChange(t)}
          className={cx(
            'min-h-10 cursor-pointer whitespace-nowrap border-b-2 bg-transparent px-3 text-sm',
            t === value ? 'border-brand font-medium text-brand' : 'border-transparent text-muted',
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
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onMouseDown={onClose}>
      <aside
        className="flex h-full max-w-full flex-col bg-bg shadow-xl"
        style={{ width }}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="详情"
      >
        <header className="flex items-center justify-between gap-3 border-b border-line bg-surface px-5 py-3">
          <h2 className="m-0 text-lg font-bold">{title}</h2>
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
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
        className="flex max-h-[90vh] w-full flex-col rounded-xl bg-surface shadow-xl"
        style={{ maxWidth: width }}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={title}
      >
        <header className="border-b border-line px-5 py-3 text-base font-bold">{title}</header>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
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

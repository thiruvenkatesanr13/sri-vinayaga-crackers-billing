import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import { paiseToInput, toPaise } from "../lib/money";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "gold" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  block?: boolean;
  loading?: boolean;
};

export function Button({ variant = "secondary", size = "md", block, loading, className, children, disabled, ...rest }: ButtonProps) {
  const classes = ["btn", variant !== "secondary" && variant, size !== "md" && size, block && "block", className]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type="button"
      className={classes}
      disabled={disabled || loading}
      data-loading={loading ? "true" : undefined}
      aria-busy={loading || undefined}
      {...rest}
    >
      {children}
    </button>
  );
}

export function IconButton({ label, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button type="button" className="icon-btn" aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {error ? <small className="error">{error}</small> : hint ? <small className="hint">{hint}</small> : null}
    </label>
  );
}

/** Rupee amount typed by a person; reports paise (or null when empty). */
export function MoneyInput({
  value,
  onChange,
  placeholder,
  autoFocus,
  id,
  ariaLabel,
  invalid,
}: {
  value: number | null;
  onChange: (paise: number | null) => void;
  placeholder?: string;
  autoFocus?: boolean;
  id?: string;
  ariaLabel?: string;
  invalid?: boolean;
}) {
  const [text, setText] = useState(paiseToInput(value));
  const last = useRef(value);
  useEffect(() => {
    if (value !== last.current) {
      setText(paiseToInput(value));
      last.current = value;
    }
  }, [value]);
  return (
    <div className="money-input">
      <input
        id={id}
        className="input"
        inputMode="decimal"
        value={text}
        placeholder={placeholder ?? "0"}
        autoFocus={autoFocus}
        aria-label={ariaLabel}
        aria-invalid={invalid || (text !== "" && toPaise(text) === null) || undefined}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          const paise = toPaise(next);
          last.current = paise;
          onChange(paise);
        }}
      />
    </div>
  );
}

export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: ReactNode; disabled?: boolean; title?: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          aria-pressed={option.value === value}
          disabled={option.disabled}
          title={option.title}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Badge({ tone = "neutral", children }: { tone?: "neutral" | "good" | "warn" | "bad" | "gold"; children: ReactNode }) {
  return <span className={`badge ${tone === "neutral" ? "" : tone}`}>{children}</span>;
}

export function Notice({ tone = "neutral", children }: { tone?: "neutral" | "good" | "warn" | "bad"; children: ReactNode }) {
  const Icon = tone === "good" ? CircleCheck : tone === "neutral" ? Info : TriangleAlert;
  return (
    <div className={`notice ${tone === "neutral" ? "" : tone}`} role={tone === "bad" ? "alert" : "status"}>
      <Icon size={16} aria-hidden />
      <div>{children}</div>
    </div>
  );
}

export function PageHead({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {actions ? <div className="row">{actions}</div> : null}
    </header>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children}
    </div>
  );
}

/** Shows nothing for a moment, so fast loads never flash a loading message. */
export function Loading({ label = "Loading" }: { label?: string }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setShow(true), 300);
    return () => window.clearTimeout(timer);
  }, []);
  return show ? <p className="muted small" role="status">{label}…</p> : null;
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button key={tab.value} type="button" role="tab" aria-selected={tab.value === value} onClick={() => onChange(tab.value)}>
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function Dialog({
  open,
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const first = node?.querySelector<HTMLElement>("[autofocus], input, select, textarea, button:not([aria-label='Close'])");
    (first ?? node)?.focus();
    const onKey = (event: KeyboardEvent) => {
      // Only the dialog on top answers keys, so Esc closes one window at a time.
      const dialogs = document.querySelectorAll(".dialog");
      if (node && dialogs[dialogs.length - 1] !== node) return;
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
      if (event.key === "Tab" && node) {
        const items = Array.from(node.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href]")).filter(
          (el) => !el.hasAttribute("disabled"),
        );
        if (!items.length) return;
        const firstItem = items[0];
        const lastItem = items[items.length - 1];
        if (event.shiftKey && document.activeElement === firstItem) {
          event.preventDefault();
          lastItem.focus();
        } else if (!event.shiftKey && document.activeElement === lastItem) {
          event.preventDefault();
          firstItem.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      previous?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className={`dialog ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref} tabIndex={-1}>
        <div className="dialog-head">
          <h2 id={titleId} style={{ fontSize: "var(--text-md)" }}>
            {title}
          </h2>
          <IconButton label="Close" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>
        <div className="dialog-body">{children}</div>
        {footer ? <div className="dialog-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

interface Toast {
  id: number;
  text: string;
  tone: "neutral" | "bad";
}

const ToastContext = createContext<(text: string, tone?: "neutral" | "bad") => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const notify = useCallback((text: string, tone: "neutral" | "bad" = "neutral") => {
    const id = Date.now() + Math.random();
    setToasts((list) => [...list.slice(-2), { id, text, tone }]);
    window.setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), tone === "bad" ? 7000 : 3500);
  }, []);
  return (
    <ToastContext.Provider value={notify}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.tone === "bad" ? "bad" : ""}`}>
            {toast.tone === "bad" ? <TriangleAlert size={16} aria-hidden /> : <CircleCheck size={16} aria-hidden />}
            <span>{toast.text}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

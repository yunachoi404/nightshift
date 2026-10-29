import { AlertCircle, Check, Info, X } from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------- Button

type ButtonVariant = "primary" | "night" | "ghost" | "quiet" | "danger" | "toolbar";
interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "s" | "m" | "l";
  icon?: ReactNode;
  busy?: boolean;
  iconOnly?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "ghost", size = "m", icon, busy, iconOnly, className, children, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx("btn", `btn--${variant}`, size !== "m" && `btn--${size}`, iconOnly && "btn--icon", className)}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <span className="spin" aria-hidden /> : icon}
      {!iconOnly && children}
    </button>
  );
});

// ---------------------------------------------------------------- Field

interface FieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: (id: string) => ReactNode;
  className?: string;
}

export function Field({ label, hint, error, children, className }: FieldProps) {
  const id = useId();
  return (
    <div className={cx("field", className)}>
      {label && (
        <label className="field__label" htmlFor={id}>
          {label}
        </label>
      )}
      {children(id)}
      {error ? <div className="field__error">{error}</div> : hint ? <div className="field__hint">{hint}</div> : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { inline?: boolean }>(function Input({ className, inline, ...rest }, ref) {
  return <input ref={ref} className={cx("input", inline && "input--inline", className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cx("textarea", className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, ...rest }, ref) {
  return <select ref={ref} className={cx("select", className)} {...rest} />;
});

// ---------------------------------------------------------------- Segmented

export interface SegOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  title?: string;
}

export function radioGroupKeyDown(e: KeyboardEvent<HTMLElement>) {
  if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"].includes(e.key)) return;
  const options = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)'));
  if (!options.length) return;
  const current = options.indexOf(document.activeElement as HTMLButtonElement);
  const next = e.key === "Home" ? 0 : e.key === "End" ? options.length - 1 : (current + (["ArrowRight", "ArrowDown"].includes(e.key) ? 1 : -1) + options.length) % options.length;
  e.preventDefault();
  options[next]?.focus();
  options[next]?.click();
}

export function Segmented<T extends string>({ value, onChange, options, label, size }: { value: T; onChange: (v: T) => void; options: SegOption<T>[]; label?: string; size?: "s" | "l" }) {
  return (
    <div className={cx("seg", size && `seg--${size}`)} role="radiogroup" aria-label={label} onKeyDown={radioGroupKeyDown}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          className="seg__opt"
          disabled={o.disabled}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- Tag, Bar

export type TagTone = "draft" | "night" | "ok" | "bad" | "accent";
export function Tag({ tone, outline, onMedia, children, className, title }: { tone?: TagTone; outline?: boolean; onMedia?: boolean; children: ReactNode; className?: string; title?: string }) {
  return (
    <span className={cx("tag", tone && `tag--${tone}`, outline && "tag--outline", onMedia && "tag--onmedia", className)} title={title}>
      {children}
    </span>
  );
}

export function Bar({ value, tone, thick, indeterminate, className }: { value: number; tone?: "night"; thick?: boolean; indeterminate?: boolean; className?: string }) {
  return (
    <div className={cx("bar", tone && `bar--${tone}`, thick && "bar--thick", indeterminate && "bar--indeterminate", className)} role="progressbar" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100}>
      <div className="bar__fill" style={indeterminate ? undefined : { width: `${Math.min(100, Math.max(0, value * 100))}%` }} />
    </div>
  );
}

// ---------------------------------------------------------------- Slider

export function Slider({ value, min, max, step = 1, onChange, label }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void; label: string }) {
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 100;
  return (
    <input
      type="range"
      className="slider"
      min={min}
      max={max}
      step={step}
      value={value}
      aria-label={label}
      style={{ "--pct": `${pct}%` } as React.CSSProperties}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}

// ---------------------------------------------------------------- Notice

export function Notice({ tone, title, children, actions, icon }: { tone?: "bad" | "night"; title?: ReactNode; children?: ReactNode; actions?: ReactNode; icon?: ReactNode }) {
  return (
    <div className={cx("notice", tone && `notice--${tone}`)} role={tone === "bad" ? "alert" : undefined}>
      {icon ?? (tone === "bad" ? <AlertCircle /> : <Info />)}
      <div style={{ minWidth: 0, flex: 1 }}>
        {title && <div className="notice__title">{title}</div>}
        {children && <div className="notice__text">{children}</div>}
        {actions && <div className="notice__actions">{actions}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Dialog

export function Dialog({ open, onClose, children, width, className }: { open: boolean; onClose: () => void; children: ReactNode; width?: number; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={cx("dialog", className)}
      style={width ? { width: `min(${width}px, calc(100vw - 48px))` } : undefined}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open && <div className="dialog__body">{children}</div>}
    </dialog>
  );
}

/** Focus an overlay, keep Tab inside it, and return to the opener on close. */
export function usePanelFocus<T extends HTMLElement = HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const panel = ref.current;
    if (!panel) return;
    const opener = document.activeElement as HTMLElement | null;
    const focusable = () => Array.from(panel.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')).filter((el) => el.getClientRects().length);
    focusable()[0]?.focus();
    const trap = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusable();
      const first = items[0];
      const last = items.at(-1);
      if (e.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
        e.preventDefault();
        first?.focus();
      }
    };
    panel.addEventListener("keydown", trap);
    return () => {
      panel.removeEventListener("keydown", trap);
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return ref;
}

// ---------------------------------------------------------------- Menu

export function Menu({ open, onClose, anchor, children, align = "right" }: { open: boolean; onClose: () => void; anchor: React.RefObject<HTMLElement | null>; children: ReactNode; align?: "left" | "right" }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDoc = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node) || anchor.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        anchor.current?.focus();
      }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
        const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
        if (!items.length) return;
        e.preventDefault();
        const i = items.indexOf(document.activeElement as HTMLElement);
        const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, anchor]);
  if (!open) return null;
  return (
    <div ref={ref} className="menu" role="menu" style={{ top: "calc(100% + 6px)", [align]: 0 } as React.CSSProperties}>
      {children}
    </div>
  );
}

export function MenuItem({ icon, children, danger, onClick }: { icon?: ReactNode; children: ReactNode; danger?: boolean; onClick: () => void }) {
  return (
    <button type="button" role="menuitem" className={cx("menu__item", danger && "menu__item--danger")} onClick={onClick}>
      {icon}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------- Toasts

export interface ToastItem {
  id: number;
  title: string;
  text?: string;
  tone?: "ok" | "bad" | "night" | "accent";
  ttl?: number;
}

type ToastListener = (items: ToastItem[]) => void;
let toastItems: ToastItem[] = [];
const toastListeners = new Set<ToastListener>();
let toastSeq = 1;

export function toast(t: Omit<ToastItem, "id">) {
  const item: ToastItem = { id: toastSeq++, ttl: 4200, ...t };
  toastItems = [...toastItems, item];
  for (const l of toastListeners) l(toastItems);
  window.setTimeout(() => dismissToast(item.id), item.ttl);
}

function dismissToast(id: number) {
  toastItems = toastItems.filter((t) => t.id !== id);
  for (const l of toastListeners) l(toastItems);
}

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>(toastItems);
  useEffect(() => {
    toastListeners.add(setItems);
    return () => {
      toastListeners.delete(setItems);
    };
  }, []);
  if (!items.length) return null;
  return (
    <div className="toasts" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className="toast">
          <span className={cx("pulse toast__dot", t.tone === "ok" ? "pulse--ok" : t.tone === "bad" ? "pulse--bad" : t.tone === "night" ? "pulse--night" : t.tone === "accent" ? "" : "pulse--idle")} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="toast__title">{t.title}</div>
            {t.text && <div className="toast__text">{t.text}</div>}
          </div>
          <Button variant="quiet" size="s" iconOnly icon={<X />} aria-label="Dismiss" onClick={() => dismissToast(t.id)} />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- Switch

export function Switch({ checked, onChange, label, children }: { checked: boolean; onChange: (v: boolean) => void; label: string; children?: ReactNode }) {
  return (
    <label className="switch">
      <input type="checkbox" aria-label={children ? undefined : label} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch__track" />
      {children && <span>{children}</span>}
    </label>
  );
}

// ---------------------------------------------------------------- small bits

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function CheckIcon() {
  return <Check />;
}

/** Keeps a boolean on while an async action runs. */
export function useBusy(): [boolean, <T>(p: Promise<T>) => Promise<T | undefined>] {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(p: Promise<T>) => {
    setBusy(true);
    try {
      return await p;
    } catch (e) {
      toast({ title: "That didn't work", text: e instanceof Error ? e.message : String(e), tone: "bad" });
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return [busy, run];
}

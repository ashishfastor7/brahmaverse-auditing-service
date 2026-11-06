import { AlertTriangle, CheckCircle2, CircleSlash, Clock, Eye, MinusCircle, PenLine, XCircle } from "lucide-react";
import { type ButtonHTMLAttributes, type ComponentProps, type ReactElement, type ReactNode, cloneElement, isValidElement, useEffect, useId, useRef, useState } from "react";
import type { AuditListRow, AuditStatus } from "../api";

type Tone = "good" | "warning" | "serious" | "critical" | "neutral";

const TONE: Record<Tone, string> = {
  good: "bg-good-soft border-good/40",
  warning: "bg-warning-soft border-warning/50",
  serious: "bg-serious-soft border-serious/50",
  critical: "bg-critical-soft border-critical/40",
  neutral: "bg-sunken border-line",
};
const ICON_TONE: Record<Tone, string> = {
  good: "text-good",
  warning: "text-warning",
  serious: "text-serious",
  critical: "text-critical",
  neutral: "text-muted",
};

/** Status chip: the icon carries the status colour; the label stays in text ink. */
export function Badge({ tone, icon: Icon, children }: { tone: Tone; icon: typeof CheckCircle2; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium text-ink whitespace-nowrap ${TONE[tone]}`}>
      <Icon size={13} className={ICON_TONE[tone]} aria-hidden />
      {children}
    </span>
  );
}

export function SuccessBadge({ result }: { result: "PASS" | "FAIL" | null }) {
  if (result === "PASS") return <Badge tone="good" icon={CheckCircle2}>Pass</Badge>;
  if (result === "FAIL") return <Badge tone="critical" icon={XCircle}>Fail</Badge>;
  return null;
}

const GOAL_LABEL = { ACHIEVED: "Achieved", PARTIAL: "Partial", NOT_ACHIEVED: "Not achieved", NOT_APPLICABLE: "Not applicable" } as const;
export function GoalBadge({ result }: { result: AuditListRow["goal_result"] | "PARTIAL" }) {
  if (!result) return null;
  if (result === "ACHIEVED") return <Badge tone="good" icon={CheckCircle2}>{GOAL_LABEL[result]}</Badge>;
  if (result === "NOT_ACHIEVED" || result === "PARTIAL") return <Badge tone="warning" icon={AlertTriangle}>{GOAL_LABEL[result]}</Badge>;
  return <Badge tone="neutral" icon={MinusCircle}>{GOAL_LABEL[result]}</Badge>;
}

export function StatusBadge({ status, reason }: { status: AuditStatus; reason?: string | null }) {
  if (status === "pending") return <Badge tone="neutral" icon={Clock}>Auditing…</Badge>;
  if (status === "failed") return <Badge tone="serious" icon={AlertTriangle}>Audit failed</Badge>;
  if (status === "skipped") return <Badge tone="neutral" icon={CircleSlash}>Skipped{reason ? ` · ${humanize(reason)}` : ""}</Badge>;
  return null;
}

export function ReviewBadge() {
  return <Badge tone="warning" icon={Eye}>Needs review</Badge>;
}

/** Severity follows the score; the track is a lighter step so the bar reads as one scale. */
export function scoreTone(score: number | null): Tone {
  if (score === null) return "neutral";
  if (score >= 75) return "good";
  if (score >= 50) return "warning";
  return "critical";
}

export function ScorePill({ score }: { score: number | null }) {
  if (score === null) return <span className="text-muted">—</span>;
  const dot = { good: "bg-good", warning: "bg-warning", critical: "bg-critical", serious: "bg-serious", neutral: "bg-muted" }[scoreTone(score)];
  return (
    <span className="inline-flex items-center gap-1.5 font-semibold tabular">
      <span className={`size-2 rounded-full ${dot}`} aria-hidden />
      {score}
    </span>
  );
}

/** Category meter: the fill carries severity; the track is a lighter step of the same ramp. */
export function Meter({ score, max }: { score: number | null; max: number }) {
  if (score === null) return <div className="h-2 w-full rounded-full bg-sunken" title="Not applicable" />;
  const share = score / max;
  const fill = share >= 0.75 ? "bg-accent" : share >= 0.5 ? "bg-warning" : "bg-critical";
  return (
    <div className="h-2 w-full rounded-full bg-accent-track" role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={score}>
      <div className={`h-2 rounded-full ${fill}`} style={{ width: `${Math.max(4, (score / max) * 100)}%` }} />
    </div>
  );
}

export function Card({ title, action, children, className = "" }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl bg-surface shadow-card ${className}`}>
      {title && (
        <header className="flex items-center justify-between gap-2 px-5 pt-4">
          <h2 className="text-base font-medium text-ink">{title}</h2>
          {action}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

/** Stat tile: label · value · optional hint. */
export function StatTile({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-xl bg-surface px-5 py-4 shadow-card">
      <div className="text-[13px] text-ink-2">{label}</div>
      <div className="tabular mt-1 text-[28px] leading-[34px] font-medium tracking-[-0.02em] text-ink">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
    </div>
  );
}

export const humanize = (code: string) => code.toLowerCase().replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());

export const formatDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";

export const formatDuration = (secs: number | null) => {
  if (secs === null || secs === undefined) return "—";
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return m ? `${m}m ${s}s` : `${s}s`;
};

/** Button on the component tokens (`.btn` in index.css): one primary per screen, near-black; press scales to 0.97. */
export function Button({
  variant = "secondary",
  compact = false,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost"; compact?: boolean }) {
  return <button {...props} className={`btn btn-${variant} ${compact ? "btn-compact" : ""} ${className}`} />;
}

/** Text input on the component tokens (`.input`); `aria-invalid` turns its border critical. */
export function Input({ className = "", ...props }: ComponentProps<"input">) {
  return <input {...props} className={`input ${className}`} />;
}

/** A label above its control, 14/500 with a 6px gap. */
export function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium text-ink">
        {label}
      </label>
      {children}
    </div>
  );
}

export function Select({ label, value, onChange, options }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 rounded-full border border-control bg-surface px-3 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Multi-line text input on the input tokens. */
export function Textarea({ className = "", ...props }: ComponentProps<"textarea">) {
  return <textarea {...props} className={`input py-2 leading-5 ${className}`} style={{ height: "auto", ...props.style }} />;
}

/**
 * A version's status: *Published vN* (live) or *Draft vN* (not live yet). Draft uses the warning tone because it is
 * a state that needs a decision: publish or discard.
 */
export function VersionBadge({ status, version }: { status: "draft" | "published"; version: number }) {
  return status === "published" ? (
    <Badge tone="good" icon={CheckCircle2}>
      Published v{version}
    </Badge>
  ) : (
    <Badge tone="warning" icon={PenLine}>
      Draft v{version}
    </Badge>
  );
}

/** On/off switch (`role="switch"`), near-black when on. Give it a visible label via `aria-labelledby` or an `aria-label`. */
export function Switch({ checked, onChange, ...props }: Omit<ComponentProps<"button">, "onChange"> & { checked: boolean; onChange: (on: boolean) => void }) {
  return <button type="button" role="switch" aria-checked={checked} className="switch" onClick={() => onChange(!checked)} {...props} />;
}

/** Range slider on the slider tokens; the fill follows the value. */
export function Slider({ value, min = 0, max = 100, className = "", ...props }: ComponentProps<"input"> & { value: number; min?: number; max?: number }) {
  const pct = `${((value - min) / (max - min)) * 100}%`;
  return (
    <input type="range" value={value} min={min} max={max} {...props} className={`slider ${className}`} style={{ ["--pct" as string]: pct }} />
  );
}

/**
 * One choice from a few, as native radios (arrow keys move between them). `options` are `[value, label]`; the
 * `legend` names the group for screen readers.
 */
export function Segmented<T extends string>({
  legend,
  value,
  options,
  onChange,
  disabled,
}: {
  legend: string;
  value: T;
  options: [T, ReactNode][];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  const name = useId();
  return (
    <fieldset className="segmented" disabled={disabled}>
      <legend className="sr-only">{legend}</legend>
      {options.map(([v, label]) => (
        <span key={v} className="contents">
          <input type="radio" id={`${name}-${v}`} name={name} value={v} checked={value === v} onChange={() => onChange(v)} />
          <label htmlFor={`${name}-${v}`}>
            <span>{label}</span>
          </label>
        </span>
      ))}
    </fieldset>
  );
}

/**
 * Modal dialog on the native `<dialog>` (focus stays inside, Esc closes). It opens when `open` is true; Esc, the
 * backdrop and `onClose` close it. The element marked `data-autofocus` gets focus when it opens (React's `autoFocus`
 * runs before the dialog is shown); focus returns to the trigger when it closes.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  size = "normal",
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer: ReactNode;
  size?: "normal" | "wide";
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      d.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    }
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className={`dialog ${size === "wide" ? "dialog-wide" : ""}`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="flex flex-col gap-4">
        <h2 id={titleId} className="text-base font-semibold text-ink">
          {title}
        </h2>
        <div className="flex flex-col gap-3 text-sm text-ink-2">{children}</div>
        <div className="flex flex-wrap justify-end gap-2 pt-1">{footer}</div>
      </div>
    </dialog>
  );
}

/** A short "what failed" note inside the block it belongs to. */
export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="enter-settle flex items-start gap-1.5 text-sm text-ink">
      <AlertTriangle size={15} className="mt-0.5 flex-none text-critical" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

/** Loading placeholder at the size of what it stands for: flat, no shimmer. */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`rounded-md bg-sunken ${className}`} aria-hidden />;
}

/**
 * A dark tooltip card on hover and keyboard focus (CSS only: `group-hover` / `group-focus-within`; `display: none` at
 * rest, so a hidden tip never widens the page). Wrap something
 * focusable (a link or button) so keyboard users reach it; the tip is announced through `aria-describedby`.
 * `side` picks above or below. Keep the text to a number and a short line.
 */
export function Tip({
  tip,
  children,
  side = "top",
  className = "",
}: {
  tip: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom";
  className?: string;
}) {
  const id = useId();
  return (
    <span className={`group/tip relative inline-flex ${className}`}>
      {/* the description goes on the focusable child itself, so screen readers announce it */}
      {isValidElement(children) ? cloneElement(children as ReactElement<{ "aria-describedby"?: string }>, { "aria-describedby": id }) : children}
      <span
        id={id}
        role="tooltip"
        className={`pointer-events-none absolute left-1/2 z-30 hidden w-max max-w-[min(16rem,calc(100vw-2rem))] -translate-x-1/2 rounded-lg bg-primary px-3 py-2 text-xs leading-[18px] text-primary-ink shadow-raised group-focus-within/tip:block group-hover/tip:block ${
          side === "top" ? "bottom-full mb-2" : "top-full mt-2"
        }`}
      >
        {tip}
      </span>
    </span>
  );
}

/**
 * A button that opens a floating panel under it (filters, date range). Closes on Esc (focus back to the button) and
 * on a tap outside. `align` puts the panel's edge under the button's left or right edge.
 */
export function Popover({
  label,
  children,
  align = "left",
  buttonClassName = "",
  panelClassName = "",
}: {
  label: ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  buttonClassName?: string;
  panelClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className={`btn btn-secondary btn-compact ${buttonClassName}`}
      >
        {label}
      </button>
      {open && (
        <div
          id={panelId}
          className={`menu-pop absolute z-30 mt-2 max-w-[calc(100vw-2rem)] rounded-xl border border-[var(--dialog-edge)] bg-surface p-3 shadow-raised ${
            // on phones every panel opens from the left edge of its button, so it stays on screen
            align === "right" ? "left-0 origin-top-left sm:right-0 sm:left-auto sm:origin-top-right" : "left-0 origin-top-left"
          } ${panelClassName}`}
        >
          {children(() => {
            setOpen(false);
            button.current?.focus();
          })}
        </div>
      )}
    </div>
  );
}

/** What a panel shows when it has nothing: a short title, one line on why, and the next step if there is one. */
export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-1 py-6">
      <p className="text-sm font-medium text-ink">{title}</p>
      {children && <p className="max-w-prose text-sm text-muted">{children}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

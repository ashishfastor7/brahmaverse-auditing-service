import { AlertTriangle, CheckCircle2, CircleSlash, Clock, Eye, MinusCircle, PenLine, XCircle } from "lucide-react";
import { type ButtonHTMLAttributes, type ComponentProps, type ReactNode, useEffect, useId, useRef } from "react";
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
    <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium text-ink whitespace-nowrap ${TONE[tone]}`}>
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

const GOAL_LABEL = { ACHIEVED: "Achieved", NOT_ACHIEVED: "Not achieved", NOT_APPLICABLE: "Not applicable" } as const;
export function GoalBadge({ result }: { result: AuditListRow["goal_result"] }) {
  if (!result) return null;
  if (result === "ACHIEVED") return <Badge tone="good" icon={CheckCircle2}>{GOAL_LABEL[result]}</Badge>;
  if (result === "NOT_ACHIEVED") return <Badge tone="warning" icon={AlertTriangle}>{GOAL_LABEL[result]}</Badge>;
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
    <section className={`rounded-xl border border-line bg-surface ${className}`}>
      {title && (
        <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {action}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

/** Stat tile: label · value · optional hint. */
export function StatTile({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-ink">{value}</div>
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
        className="h-8 rounded-md border border-line bg-surface px-2 text-sm text-ink focus:outline-2 focus:outline-accent"
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

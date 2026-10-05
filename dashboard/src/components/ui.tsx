import { AlertTriangle, CheckCircle2, CircleSlash, Clock, Eye, MinusCircle, XCircle } from "lucide-react";
import type { ReactNode } from "react";
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

/** 0–4 dimension meter. */
export function Meter({ score, max = 4 }: { score: number | null; max?: number }) {
  if (score === null) return <div className="h-2 w-full rounded-full bg-sunken" title="Not applicable" />;
  const fill = score >= 3 ? "bg-accent" : score >= 2 ? "bg-warning" : "bg-critical";
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

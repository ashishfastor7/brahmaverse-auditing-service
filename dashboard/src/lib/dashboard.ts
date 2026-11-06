import type { Dashboard, DashboardFilters, Kpi, KpiKey, OutcomeBucket, Rate } from "../api";

/**
 * System dashboard helpers: copy, number formats, deltas, call-list links and the CSV export. Pure, so the page and
 * its charts share one wording and one rounding (a number is the same everywhere it appears).
 */

const nf = new Intl.NumberFormat("en-IN");
export const fmtCount = (n: number) => nf.format(n);

/** A rate as a whole percent; `—` when nothing backs it; `<1%` for a tiny non-zero share. */
export function fmtPct(r: Rate | null | undefined): string {
  if (!r || r.value === null) return "—";
  const p = r.value * 100;
  if (p > 0 && p < 1) return "<1%";
  return `${Math.round(p)}%`;
}

export const fmtScore = (r: Rate | null | undefined) => (!r || r.value === null ? "—" : r.value.toFixed(1));

export type KpiDef = {
  key: KpiKey;
  label: string;
  kind: "count" | "rate" | "score";
  /** Which way is good: `up`, `down`, or `neutral` (volume). */
  better: "up" | "down" | "neutral";
  /** The tooltip: what the numerator and denominator are. */
  tip: (r: Rate) => string;
  /** Call-list filters for the calls behind the number. */
  link: Record<string, string>;
};

export const KPIS: KpiDef[] = [
  { key: "total_calls", label: "Total calls", kind: "count", better: "neutral", tip: (r) => `${fmtCount(r.num)} calls placed or received`, link: {} },
  {
    key: "connect_rate",
    label: "Connect rate",
    kind: "rate",
    better: "up",
    tip: (r) => `${fmtCount(r.num)} of ${fmtCount(r.den)} calls connected (completed vs no answer or failed)`,
    link: { status: "completed" },
  },
  {
    key: "audit_coverage",
    label: "Audited",
    kind: "rate",
    better: "neutral",
    tip: (r) => `${fmtCount(r.num)} of ${fmtCount(r.den)} connected calls audited`,
    link: { audit: "audited" },
  },
  {
    key: "pass_rate",
    label: "Pass rate",
    kind: "rate",
    better: "up",
    tip: (r) => `${fmtCount(r.num)} of ${fmtCount(r.den)} audited calls passed`,
    link: { success: "PASS" },
  },
  {
    key: "system_goal_rate",
    label: "System goal",
    kind: "rate",
    better: "up",
    tip: (r) => `${fmtCount(r.num)} of ${fmtCount(r.den)} applicable calls passed every system check`,
    link: { system_goal: "PASS" },
  },
  {
    key: "business_goal_rate",
    label: "Business goal",
    kind: "rate",
    better: "up",
    tip: (r) => `${fmtCount(r.num)} of ${fmtCount(r.den)} applicable calls achieved the goal. Partial doesn't count as achieved.`,
    link: { business_goal: "ACHIEVED" },
  },
  {
    key: "average_score",
    label: "Avg score",
    kind: "score",
    better: "up",
    tip: (r) => `Mean score of ${fmtCount(r.den)} scored calls`,
    link: { audit: "audited" },
  },
  {
    key: "needs_review",
    label: "Needs review",
    kind: "count",
    better: "down",
    tip: (r) => `${fmtCount(r.num)} of ${fmtCount(r.den)} audited calls flagged for a person to check`,
    link: { needs_review: "true" },
  },
];

export const kpiValue = (def: KpiDef, r: Rate) => (def.kind === "rate" ? fmtPct(r) : def.kind === "score" ? fmtScore(r) : fmtCount(r.num));

export type Delta = { text: string; tone: "good" | "bad" | "neutral" } | null;

/**
 * The change against the previous period, coloured by meaning. Rates move in points, counts in percent, scores in
 * points. A base under 5 calls reads "was N" in grey instead of a dramatic percentage.
 */
export function kpiDelta(def: KpiDef, k: Kpi): Delta {
  const prev = k.previous;
  if (!prev) return null;
  const cur = k.current;
  let diff: number;
  let text: string;
  if (def.kind === "count") {
    if (prev.num < 5) return { text: `was ${fmtCount(prev.num)}`, tone: "neutral" };
    diff = (cur.num - prev.num) / prev.num;
    if (Math.abs(diff) < 0.005) return { text: "±0%", tone: "neutral" };
    const pct = Math.abs(diff) > 9.99 ? "10×+" : `${Math.round(Math.abs(diff) * 100)}%`;
    text = `${diff > 0 ? "▲" : "▼"} ${pct}`;
  } else {
    if (prev.value === null || cur.value === null) return prev.value === null ? null : { text: `was ${def.kind === "rate" ? fmtPct(prev) : fmtScore(prev)}`, tone: "neutral" };
    if (prev.den < 5) return { text: `was ${def.kind === "rate" ? fmtPct(prev) : fmtScore(prev)}`, tone: "neutral" };
    diff = def.kind === "rate" ? (cur.value - prev.value) * 100 : cur.value - prev.value;
    const shown = def.kind === "rate" ? Math.round(Math.abs(diff)) : Math.round(Math.abs(diff) * 10) / 10;
    if (shown === 0) return { text: "±0 pts", tone: "neutral" };
    text = `${diff > 0 ? "▲" : "▼"} ${shown} pts`;
  }
  const tone = def.better === "neutral" ? "neutral" : (diff > 0) === (def.better === "up") ? "good" : "bad";
  return { text, tone };
}

export const BUCKETS: { key: OutcomeBucket; label: string; tip: string; tone: "good" | "warning" | "critical" | "serious" | "neutral" }[] = [
  { key: "success", label: "Success", tip: "System goal passed and business goal achieved", tone: "good" },
  { key: "business_miss", label: "Business miss", tip: "The AI did its job; the business goal wasn't achieved (Partial counts here)", tone: "warning" },
  { key: "ai_failure", label: "AI failure", tip: "System goal failed and the business goal wasn't achieved", tone: "critical" },
  { key: "achieved_despite_ai", label: "Achieved despite AI", tip: "Business goal achieved although the system goal failed", tone: "serious" },
];

export const FUNNEL_LABELS: Record<string, string> = {
  connected: "Connected",
  audited: "Audited",
  conversation_completed: "Conversation completed",
  goal_discussed: "Goal discussed",
  achieved: "Goal achieved",
};
export const FUNNEL_TIPS: Record<string, string> = {
  connected: "Calls that were answered and completed",
  audited: "Connected calls with a current audit",
  conversation_completed: "Audited calls whose system check S2 (conversation handled) didn't fail",
  goal_discussed: "Audited calls where the business goal applied",
  achieved: "Calls that achieved the business goal; Partial is shown beside it",
};

export const humanize = (code: string) => code.toLowerCase().replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());

/** IST day → the UTC instant it starts (`from` of the call list's half-open range). */
const istStart = (day: string) => new Date(`${day}T00:00:00+05:30`).toISOString();
const istEnd = (day: string) => new Date(new Date(`${day}T00:00:00+05:30`).getTime() + 86_400_000).toISOString();

/**
 * The call list (`#/?…`) showing the calls behind a number: v2 audits, the dashboard's range, agent, direction,
 * scorecard and goal, plus `extra`. Days are IST, like the dashboard.
 */
export function callsHref(f: Dashboard["filters"], extra: Record<string, string> = {}, days?: { from: string; to: string }): string {
  const p = new URLSearchParams({ engine: "v2", from: istStart(days?.from ?? f.from), to: istEnd(days?.to ?? f.to) });
  if (f.agent) p.set("agent_code", f.agent);
  if (f.direction && f.direction !== "unknown") p.set("call_type", f.direction);
  if (f.scorecard) p.set("scorecard", f.scorecard);
  if (f.goal) p.set("goal_version", f.goal);
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  // the dashboard view to go back to (the call list's "← Dashboard")
  const back = new URLSearchParams({ from: f.from, to: f.to });
  if (f.agent) back.set("agent", f.agent);
  if (f.direction) back.set("direction", f.direction);
  if (f.goal) back.set("goal", f.goal);
  if (f.scorecard) back.set("scorecard", f.scorecard);
  if (f.compare) back.set("compare", "1");
  if (f.mode === "rescored") back.set("mode", "rescored");
  p.set("back", back.toString());
  return `#/?${p}`;
}

export const dashboardHref = (f: DashboardFilters) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v) p.set(k, String(v));
  const s = p.toString();
  return `#/dashboard${s ? `?${s}` : ""}`;
};

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

/** The KPIs and the agent table as CSV, with numerators and denominators (no rounding lost). */
export function dashboardCsv(d: Dashboard): string {
  const rows: unknown[][] = [
    ["System dashboard", `${d.filters.from} to ${d.filters.to} (IST)`, d.filters.mode === "rescored" ? "re-scored" : "as audited"],
    [],
    ["Metric", "Value", "Numerator", "Denominator", "Previous value"],
    ...KPIS.map((def) => {
      const k = d.kpis[def.key];
      return [def.label, kpiValue(def, k.current), k.current.num, k.current.den, k.previous ? kpiValue(def, k.previous) : ""];
    }),
    ["Partial share", fmtPct(d.kpis.partial_share.current), d.kpis.partial_share.current.num, d.kpis.partial_share.current.den, ""],
    [],
    ["Agent", "Calls", "Connected", "Audited", "Pass rate", "System goal", "Business goal", "Partial", "Avg score"],
    ...d.agents.map((a) => [
      a.label,
      a.total_calls,
      a.connected,
      a.audited,
      fmtPct(a.pass_rate),
      fmtPct(a.system_goal_rate),
      fmtPct(a.business_goal_rate),
      fmtPct(a.partial_share),
      fmtScore(a.average_score),
    ]),
  ];
  return rows.map((r) => r.map(csvCell).join(",")).join("\n");
}

export function downloadCsv(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** "Mon 2 Nov" style short day label. */
export const shortDay = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

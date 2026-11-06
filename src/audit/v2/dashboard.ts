import { agents } from "@/audit/rubrics";
import { HISTOGRAM_BINS, OUTCOME_BUCKETS, type OutcomeBucket, UNKNOWN_AGENT, daysBetween, istDayRange } from "./rollup";
import { DAY_MS } from "./spot-check";

/**
 * P2-7 – P2-9 System Dashboard (PRD §6), pure: everything the page shows, from `daily_rollup` / `daily_call_rollup`
 * rows plus small lookups. No I/O; `routes/dashboard.ts` loads the rows and calls `dashboardSummary`.
 *
 * Every rate is `{ num, den, value }` so the page can show its denominator ("412 of 1,006 applicable calls"), and
 * every count adds up across days, agents and versions exactly, because only counts are summed.
 */

/** The `daily_rollup` columns the dashboard reads (as the DB returns them). */
export type AuditRow = {
  day: string;
  agent_code: string;
  direction: string;
  scorecard_id: string;
  scorecard_version: number;
  goal_version: number;
  audited: number;
  sampled: number;
  passed: number;
  failed: number;
  needs_review: number;
  system_pass: number;
  system_fail: number;
  system_na: number;
  business_achieved: number;
  business_partial: number;
  business_not_achieved: number;
  business_na: number;
  score_sum: number;
  scored: number;
  buckets: Partial<Record<OutcomeBucket, number>>;
  histogram: number[];
  metric_averages: Record<string, { n: number; score_sum: number; max_sum: number; lost?: number }>;
  failure_codes: Record<string, number>;
  system_checks: Record<string, { pass: number; fail: number; na: number }>;
  business_reasons: Record<string, number>;
  rs_passed: number;
  rs_failed: number;
  rs_score_sum: number;
  rs_scored: number;
  rs_histogram: number[];
};

/** The `daily_call_rollup` columns. */
export type CallRow = { day: string; agent_code: string; direction: string; total: number; connected: number; not_connected: number };

export type Mode = "as_audited" | "rescored";

export type DashboardFilters = {
  from: string;
  to: string;
  agent?: string;
  direction?: string;
  /** `agent@version` */
  goal?: string;
  /** `scorecard_id@version` */
  scorecard?: string;
  compare: boolean;
  mode: Mode;
};

export type Marker = { day: string; agent_code: string | null; type: string; label: string };

export type Lookups = {
  /** `scorecard_id@version` → pass threshold. */
  thresholds: Record<string, number>;
  metricLabels: Record<string, string>;
  conditionLabels: Record<string, string>;
  markers: Marker[];
};

export type Rate = { num: number; den: number; value: number | null };
export type Kpi = { current: Rate; previous: Rate | null };

const rate = (num: number, den: number): Rate => ({ num, den, value: den > 0 ? num / den : null });
const round1 = (n: number) => Math.round(n * 10) / 10;

/** `day` moved by `n` calendar days (`YYYY-MM-DD`). */
export const shiftDay = (day: string, n: number) => new Date(istDayRange(day).from.getTime() + 5.5 * 3_600_000 + n * DAY_MS).toISOString().slice(0, 10);

/** Default range: the last 7 IST days including today. */
export const defaultRange = (today: string) => ({ from: shiftDay(today, -6), to: today });

/** The period just before [from, to], the same number of days long. */
export function previousRange(from: string, to: string): { from: string; to: string } {
  const days = daysBetween(from, to).length;
  return { from: shiftDay(from, -days), to: shiftDay(from, -1) };
}

/** Trend bucket of a day: the day itself, or the Monday starting its week when the range is long. */
export function trendBucket(day: string, weekly: boolean): string {
  if (!weekly) return day;
  const d = new Date(`${day}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - back * DAY_MS).toISOString().slice(0, 10);
}

/** Ranges longer than this show weekly trend points. */
export const WEEKLY_AFTER_DAYS = 60;
/** Fewer audited calls than this behind a number shows the small-sample warning (PRD §6). */
export const LOW_SAMPLE = 30;

const inRange = (day: string, from: string, to: string) => day >= from && day <= to;

/** Rows matching the filters other than the date. Call rows have no goal or scorecard, so only agent and direction apply. */
export function filterAuditRows(rows: AuditRow[], f: Omit<DashboardFilters, "from" | "to" | "compare" | "mode">) {
  return rows.filter(
    (r) =>
      (!f.agent || r.agent_code === f.agent) &&
      (!f.direction || r.direction === f.direction) &&
      (!f.goal || `${r.agent_code}@${r.goal_version}` === f.goal) &&
      (!f.scorecard || `${r.scorecard_id}@${r.scorecard_version}` === f.scorecard),
  );
}
export function filterCallRows(rows: CallRow[], f: Pick<DashboardFilters, "agent" | "direction">) {
  return rows.filter((r) => (!f.agent || r.agent_code === f.agent) && (!f.direction || r.direction === f.direction));
}

/** Summed counts of a set of audit rows, in the chosen mode. */
export type Totals = ReturnType<typeof totals>;
export function totals(rows: AuditRow[], mode: Mode) {
  const t = {
    audited: 0,
    sampled: 0,
    passed: 0,
    failed: 0,
    needs_review: 0,
    system_pass: 0,
    system_fail: 0,
    business_achieved: 0,
    business_partial: 0,
    business_not_achieved: 0,
    score_sum: 0,
    scored: 0,
    histogram: [0, 0, 0, 0, 0],
    buckets: Object.fromEntries(OUTCOME_BUCKETS.map((b) => [b, 0])) as Record<OutcomeBucket, number>,
    s2_fail: 0,
  };
  const rs = mode === "rescored";
  for (const r of rows) {
    t.audited += r.audited;
    t.sampled += r.sampled;
    t.passed += rs ? r.rs_passed : r.passed;
    t.failed += rs ? r.rs_failed : r.failed;
    t.needs_review += r.needs_review;
    t.system_pass += r.system_pass;
    t.system_fail += r.system_fail;
    t.business_achieved += r.business_achieved;
    t.business_partial += r.business_partial;
    t.business_not_achieved += r.business_not_achieved;
    t.score_sum += rs ? Number(r.rs_score_sum) : Number(r.score_sum);
    t.scored += rs ? r.rs_scored : r.scored;
    (rs ? r.rs_histogram : r.histogram).forEach((n, i) => (t.histogram[i]! += n));
    for (const b of OUTCOME_BUCKETS) t.buckets[b] += r.buckets[b] ?? 0;
    t.s2_fail += r.system_checks.S2?.fail ?? 0;
  }
  t.score_sum = round1(t.score_sum);
  return t;
}

function callTotals(rows: CallRow[]) {
  return rows.reduce((t, r) => ({ total: t.total + r.total, connected: t.connected + r.connected, not_connected: t.not_connected + r.not_connected }), {
    total: 0,
    connected: 0,
    not_connected: 0,
  });
}

/** The headline rates of a period. Average score is a "rate" of score_sum over scored calls (value in points). */
function rates(t: Totals, c: ReturnType<typeof callTotals>) {
  const applicable = t.business_achieved + t.business_partial + t.business_not_achieved;
  return {
    total_calls: rate(c.total, c.total),
    connected: rate(c.connected, c.total),
    connect_rate: rate(c.connected, c.connected + c.not_connected),
    audit_coverage: rate(t.audited, c.connected),
    pass_rate: rate(t.passed, t.passed + t.failed),
    system_goal_rate: rate(t.system_pass, t.system_pass + t.system_fail),
    business_goal_rate: rate(t.business_achieved, applicable),
    partial_share: rate(t.business_partial, applicable),
    average_score: { num: t.score_sum, den: t.scored, value: t.scored > 0 ? round1(t.score_sum / t.scored) : null },
    needs_review: rate(t.needs_review, t.audited),
  };
}
export type KpiKey = keyof ReturnType<typeof rates>;

const sumInto = (into: Record<string, number>, from: Record<string, number>) => {
  for (const [k, n] of Object.entries(from)) into[k] = (into[k] ?? 0) + n;
};

/** The whole dashboard for the filters: current period, and the previous one when comparing. */
export function dashboardSummary(allAudits: AuditRow[], allCalls: CallRow[], f: DashboardFilters, lookups: Lookups) {
  const prev = previousRange(f.from, f.to);
  const audits = filterAuditRows(allAudits, f);
  const calls = filterCallRows(allCalls, f);
  const cur = audits.filter((r) => inRange(r.day, f.from, f.to));
  const curCalls = calls.filter((r) => inRange(r.day, f.from, f.to));
  const prevAudits = audits.filter((r) => inRange(r.day, prev.from, prev.to));
  const prevCalls = calls.filter((r) => inRange(r.day, prev.from, prev.to));

  const t = totals(cur, f.mode);
  const pt = totals(prevAudits, f.mode);
  const now = rates(t, callTotals(curCalls));
  const before = rates(pt, callTotals(prevCalls));
  const kpis = Object.fromEntries(
    (Object.keys(now) as KpiKey[]).map((k) => [k, { current: now[k], previous: f.compare ? before[k] : null } satisfies Kpi]),
  ) as Record<KpiKey, Kpi>;

  // Trend: one point per day (or week), lines broken where the scorecard versions in a point change.
  const days = daysBetween(f.from, f.to);
  const weekly = days.length > WEEKLY_AFTER_DAYS;
  const points = [...new Set(days.map((d) => trendBucket(d, weekly)))];
  const trend = points.map((bucket) => {
    const rows = cur.filter((r) => trendBucket(r.day, weekly) === bucket);
    const bt = totals(rows, f.mode);
    const r = rates(bt, { total: 0, connected: 0, not_connected: 0 });
    return {
      bucket,
      audited: bt.audited,
      pass_rate: r.pass_rate,
      system_goal_rate: r.system_goal_rate,
      business_goal_rate: r.business_goal_rate,
      versions: [...new Set(rows.map((x) => `${x.scorecard_id}@${x.scorecard_version}`))].sort(),
    };
  });

  // Histogram threshold: the pass threshold, when every scorecard version in range shares one.
  const versions = [...new Set(cur.map((r) => `${r.scorecard_id}@${r.scorecard_version}`))];
  const thresholds = [...new Set(versions.map((v) => lookups.thresholds[v]).filter((x): x is number => x !== undefined))];
  const histogram = {
    bins: HISTOGRAM_BINS.map((label, i) => ({ label, calls: t.histogram[i]!, previous: f.compare ? pt.histogram[i]! : null })),
    scored: t.scored,
    threshold: thresholds.length === 1 ? thresholds[0]! : null,
  };

  // Top failure causes: failure conditions, failed system checks and metrics by calls under full marks.
  const codes: Record<string, number> = {};
  const checks: Record<string, { fail: number; applicable: number }> = {};
  const metrics: Record<string, { n: number; score_sum: number; max_sum: number; lost: number }> = {};
  const reasons: Record<string, number> = {};
  for (const r of cur) {
    sumInto(codes, r.failure_codes);
    sumInto(reasons, r.business_reasons);
    for (const [code, c] of Object.entries(r.system_checks)) {
      const x = (checks[code] ??= { fail: 0, applicable: 0 });
      x.fail += c.fail;
      x.applicable += c.pass + c.fail;
    }
    for (const [key, m] of Object.entries(r.metric_averages)) {
      const x = (metrics[key] ??= { n: 0, score_sum: 0, max_sum: 0, lost: 0 });
      x.n += m.n;
      x.score_sum += m.score_sum;
      x.max_sum += m.max_sum;
      x.lost += m.lost ?? 0;
    }
  }
  const failures = [
    ...Object.entries(codes).map(([code, n]) => ({
      kind: "condition" as const,
      key: code,
      label: lookups.conditionLabels[code] ?? code,
      calls: n,
      of: t.audited,
    })),
    ...Object.entries(checks)
      .filter(([, c]) => c.fail > 0)
      .map(([code, c]) => ({ kind: "check" as const, key: code, label: CHECK_LABELS[code] ?? code, calls: c.fail, of: c.applicable })),
    ...Object.entries(metrics)
      .filter(([, m]) => m.lost > 0)
      .map(([key, m]) => ({ kind: "metric" as const, key, label: lookups.metricLabels[key] ?? key, calls: m.lost, of: m.n })),
  ].sort((a, b) => b.calls - a.calls || a.label.localeCompare(b.label));

  // Heatmap: agents × metrics, average % (score_sum ÷ max_sum).
  const agentCodes = [...new Set(cur.map((r) => r.agent_code))].sort(byAgent);
  const metricKeys = Object.entries(metrics)
    .sort((a, b) => (lookups.metricLabels[a[0]] ?? a[0]).localeCompare(lookups.metricLabels[b[0]] ?? b[0]))
    .map(([k]) => k);
  const heatmap = {
    agents: agentCodes.map((code) => ({ code, label: agentLabel(code) })),
    metrics: metricKeys.map((key) => ({ key, label: lookups.metricLabels[key] ?? key })),
    cells: agentCodes.map((code) =>
      metricKeys.map((key) => {
        let score = 0;
        let max = 0;
        let n = 0;
        for (const r of cur) {
          const m = r.agent_code === code ? r.metric_averages[key] : undefined;
          if (m) {
            score += m.score_sum;
            max += m.max_sum;
            n += m.n;
          }
        }
        return { n, value: max > 0 ? Math.round((1000 * score) / max) / 10 : null };
      }),
    ),
  };

  // Funnel per agent and for all: connected → audited → conversation completed → goal discussed → achieved.
  const funnelFor = (agent: string | null) => {
    const rows = agent ? cur.filter((r) => r.agent_code === agent) : cur;
    const c = callTotals(agent ? curCalls.filter((r) => r.agent_code === agent) : curCalls);
    const at = totals(rows, f.mode);
    const why: Record<string, number> = {};
    for (const r of rows) sumInto(why, r.business_reasons);
    return {
      agent,
      label: agent ? agentLabel(agent) : "All agents",
      stages: [
        { key: "connected", calls: c.connected },
        { key: "audited", calls: at.audited },
        { key: "conversation_completed", calls: at.audited - at.s2_fail },
        { key: "goal_discussed", calls: at.business_achieved + at.business_partial + at.business_not_achieved },
        { key: "achieved", calls: at.business_achieved },
      ],
      partial: at.business_partial,
      not_achieved: at.business_not_achieved,
      reasons: Object.entries(why)
        .map(([reason, calls]) => ({ reason, calls }))
        .sort((a, b) => b.calls - a.calls),
    };
  };
  const funnelAgents = [...new Set([...agentCodes, ...curCalls.filter((r) => r.connected > 0).map((r) => r.agent_code)])].sort(byAgent);
  const funnel = [funnelFor(null), ...(funnelAgents.length > 1 ? funnelAgents.map(funnelFor) : [])];

  // Agent table, with a daily pass-rate sparkline.
  const agentRows = [...new Set([...agentCodes, ...curCalls.map((r) => r.agent_code)])].sort(byAgent).map((code) => {
    const rows = cur.filter((r) => r.agent_code === code);
    const at = totals(rows, f.mode);
    const r = rates(at, callTotals(curCalls.filter((x) => x.agent_code === code)));
    const pr = rates(totals(prevAudits.filter((x) => x.agent_code === code), f.mode), callTotals(prevCalls.filter((x) => x.agent_code === code)));
    return {
      code,
      label: agentLabel(code),
      total_calls: r.total_calls.num,
      connected: r.connected.num,
      audited: at.audited,
      pass_rate: r.pass_rate,
      system_goal_rate: r.system_goal_rate,
      business_goal_rate: r.business_goal_rate,
      partial_share: r.partial_share,
      average_score: r.average_score,
      previous_pass_rate: f.compare ? pr.pass_rate : null,
      spark: points.map((bucket) => {
        const bt = totals(
          rows.filter((x) => trendBucket(x.day, weekly) === bucket),
          f.mode,
        );
        return rate(bt.passed, bt.passed + bt.failed).value;
      }),
    };
  });

  const markers = lookups.markers
    .filter((m) => inRange(m.day, f.from, f.to) && (!f.agent || m.agent_code === null || m.agent_code === f.agent))
    .map((m) => ({ ...m, bucket: trendBucket(m.day, weekly) }));

  return {
    filters: f,
    previous: f.compare ? prev : null,
    bucket: weekly ? ("week" as const) : ("day" as const),
    sample: {
      audited: t.audited,
      sampled: t.sampled,
      hand_picked: t.audited - t.sampled,
      low: t.audited < LOW_SAMPLE,
    },
    kpis,
    trend,
    markers,
    histogram,
    failures,
    buckets: {
      current: t.buckets,
      previous: f.compare ? pt.buckets : null,
    },
    heatmap,
    funnel,
    agents: agentRows,
  };
}

export type DashboardSummary = ReturnType<typeof dashboardSummary>;

export const CHECK_LABELS: Record<string, string> = {
  S1: "S1 Connected",
  S2: "S2 Conversation handled",
  S3: "S3 Flow completed",
  S4: "S4 Data saved",
};

const ORDER = [...agents.map((a) => a.code), UNKNOWN_AGENT];
const byAgent = (a: string, b: string) => ORDER.indexOf(a) - ORDER.indexOf(b) || a.localeCompare(b);
export const agentLabel = (code: string) => agents.find((a) => a.code === code)?.label ?? (code === UNKNOWN_AGENT ? "Unknown agent" : code);

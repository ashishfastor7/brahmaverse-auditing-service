import { agentFor } from "@/audit/rubrics";
import { DAY_MS, IST_OFFSET_MS } from "./spot-check";

/**
 * P2-6 daily roll-ups (PRD §6, §7), pure: what `src/db/rollup.ts` stores per IST day, agent and scorecard version, and
 * the rates a dashboard derives from it. Only counts and sums are stored, so any range adds up exactly (no average of
 * averages); `rollupRates` turns them into rates.
 */

export const UNKNOWN_AGENT = "unknown";
export const HISTOGRAM_BINS = ["0-20", "20-40", "40-60", "60-80", "80-100"] as const;
export const OUTCOME_BUCKETS = ["success", "business_miss", "ai_failure", "achieved_despite_ai", "na"] as const;
export type OutcomeBucket = (typeof OUTCOME_BUCKETS)[number];

/** The IST calendar day `at` falls in, as `YYYY-MM-DD` (PRD §6: daily buckets use IST). */
export function istDay(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** IST day `day` as a half-open UTC range. Throws on anything but a real `YYYY-MM-DD`. */
export function istDayRange(day: string): { from: Date; to: Date } {
  const midnight = new Date(`${day}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(midnight.getTime()) || midnight.toISOString().slice(0, 10) !== day)
    throw new Error(`day must be a YYYY-MM-DD date, not ${day}`);
  const from = new Date(midnight.getTime() - IST_OFFSET_MS);
  return { from, to: new Date(from.getTime() + DAY_MS) };
}

/** Score histogram bin (PRD §6 item 4): [0,20) [20,40) [40,60) [60,80) [80,100]; 100 lands in the last bin. */
export function histogramBin(score: number): number {
  return Math.min(4, Math.max(0, Math.floor(score / 20)));
}

type SystemGoal = "PASS" | "FAIL" | "NOT_APPLICABLE";
type BusinessGoal = "ACHIEVED" | "PARTIAL" | "NOT_ACHIEVED" | "NOT_APPLICABLE";

/**
 * The system × business outcome bucket (PRD §3). PARTIAL counts as not achieved (§3.3); a call with either goal N/A or
 * missing is `na`.
 * - `success`: system PASS, business ACHIEVED.
 * - `business_miss`: system PASS, business not achieved (the business team's bucket).
 * - `ai_failure`: system FAIL, business not achieved (the engineering priority).
 * - `achieved_despite_ai`: system FAIL, business ACHIEVED.
 */
export function outcomeBucket(system: SystemGoal | null, business: BusinessGoal | null): OutcomeBucket {
  if ((system !== "PASS" && system !== "FAIL") || !business || business === "NOT_APPLICABLE") return "na";
  const achieved = business === "ACHIEVED";
  if (system === "PASS") return achieved ? "success" : "business_miss";
  return achieved ? "achieved_despite_ai" : "ai_failure";
}

/** One current v2 audit (completed, not superseded), as the roll-up reads it. */
export type RollupAudit = {
  call_created_at: Date;
  agent_code: string | null;
  agent_id: number | null;
  scorecard_id: string;
  scorecard_version: number;
  score: number | null;
  success_result: "PASS" | "FAIL" | null;
  system_goal: SystemGoal | null;
  business_goal: BusinessGoal | null;
  failure_codes: string[];
  needs_review: boolean;
  metrics: { key: string; score: number | null; max: number; n_a: boolean }[];
};

export type MetricSum = { n: number; score_sum: number; max_sum: number };

/** One `daily_rollup` row. */
export type AuditRollup = {
  day: string;
  agent_code: string;
  scorecard_id: string;
  scorecard_version: number;
  audited: number;
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
  buckets: Record<OutcomeBucket, number>;
  histogram: number[];
  metric_averages: Record<string, MetricSum>;
  failure_codes: Record<string, number>;
};

export const rollupAgent = (agent_code: string | null, agent_id: number | null) => agentFor(agent_code, agent_id)?.code ?? UNKNOWN_AGENT;

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;

function emptyRollup(day: string, agent_code: string, scorecard_id: string, scorecard_version: number): AuditRollup {
  return {
    day,
    agent_code,
    scorecard_id,
    scorecard_version,
    audited: 0,
    passed: 0,
    failed: 0,
    needs_review: 0,
    system_pass: 0,
    system_fail: 0,
    system_na: 0,
    business_achieved: 0,
    business_partial: 0,
    business_not_achieved: 0,
    business_na: 0,
    score_sum: 0,
    scored: 0,
    buckets: Object.fromEntries(OUTCOME_BUCKETS.map((b) => [b, 0])) as Record<OutcomeBucket, number>,
    histogram: [0, 0, 0, 0, 0],
    metric_averages: {},
    failure_codes: {},
  };
}

/** Groups current audits into `daily_rollup` rows, sorted by day, agent, scorecard, version. */
export function buildAuditRollups(audits: RollupAudit[]): AuditRollup[] {
  const byKey = new Map<string, AuditRollup>();
  for (const a of audits) {
    const day = istDay(a.call_created_at);
    const agent = rollupAgent(a.agent_code, a.agent_id);
    const key = [day, agent, a.scorecard_id, a.scorecard_version].join("|");
    let r = byKey.get(key);
    if (!r) byKey.set(key, (r = emptyRollup(day, agent, a.scorecard_id, a.scorecard_version)));

    r.audited++;
    if (a.success_result === "PASS") r.passed++;
    else if (a.success_result === "FAIL") r.failed++;
    if (a.needs_review) r.needs_review++;

    if (a.system_goal === "PASS") r.system_pass++;
    else if (a.system_goal === "FAIL") r.system_fail++;
    else r.system_na++;

    if (a.business_goal === "ACHIEVED") r.business_achieved++;
    else if (a.business_goal === "PARTIAL") r.business_partial++;
    else if (a.business_goal === "NOT_ACHIEVED") r.business_not_achieved++;
    else r.business_na++;

    r.buckets[outcomeBucket(a.system_goal, a.business_goal)]++;

    if (a.score !== null) {
      r.scored++;
      r.score_sum = round(r.score_sum + a.score, 1);
      r.histogram[histogramBin(a.score)]!++;
    }

    for (const m of a.metrics) {
      if (m.n_a || m.score === null) continue;
      const sum = (r.metric_averages[m.key] ??= { n: 0, score_sum: 0, max_sum: 0 });
      sum.n++;
      sum.score_sum = round(sum.score_sum + m.score, 2);
      sum.max_sum = round(sum.max_sum + m.max, 2);
    }

    // calls per code: an audit with two flags of one code counts once
    for (const code of new Set(a.failure_codes)) r.failure_codes[code] = (r.failure_codes[code] ?? 0) + 1;
  }
  const cmp = (a: AuditRollup, b: AuditRollup) =>
    a.day.localeCompare(b.day) ||
    a.agent_code.localeCompare(b.agent_code) ||
    a.scorecard_id.localeCompare(b.scorecard_id) ||
    a.scorecard_version - b.scorecard_version;
  return [...byKey.values()].sort(cmp);
}

/** Source call counts grouped by IST day, agent and status (`sourceCallCountsByDay`). */
export type CallStatusGroup = { day: string; agent_code: string | null; agent_id: number | null; status: string | null; n: number };

/** One `daily_call_rollup` row. */
export type CallRollup = { day: string; agent_code: string; total: number; connected: number; not_connected: number };

export const CONNECTED_STATUSES = ["completed"];
export const NOT_CONNECTED_STATUSES = ["no_answer", "failed"];

/** Sums status groups into `daily_call_rollup` rows: connected = completed, not connected = no_answer + failed. */
export function buildCallRollups(groups: CallStatusGroup[]): CallRollup[] {
  const byKey = new Map<string, CallRollup>();
  for (const g of groups) {
    const agent = rollupAgent(g.agent_code, g.agent_id);
    const key = `${g.day}|${agent}`;
    let r = byKey.get(key);
    if (!r) byKey.set(key, (r = { day: g.day, agent_code: agent, total: 0, connected: 0, not_connected: 0 }));
    r.total += g.n;
    if (g.status && CONNECTED_STATUSES.includes(g.status)) r.connected += g.n;
    else if (g.status && NOT_CONNECTED_STATUSES.includes(g.status)) r.not_connected += g.n;
  }
  return [...byKey.values()].sort((a, b) => a.day.localeCompare(b.day) || a.agent_code.localeCompare(b.agent_code));
}

const rate = (n: number, of: number) => (of > 0 ? n / of : null);

/**
 * Rates from summed roll-up counts (null when nothing backs them). Goal rates count applicable calls only; Partial is
 * not achieved and has its own share (PRD §3.3).
 */
export function rollupRates(
  a: Pick<
    AuditRollup,
    | "passed"
    | "failed"
    | "system_pass"
    | "system_fail"
    | "business_achieved"
    | "business_partial"
    | "business_not_achieved"
    | "score_sum"
    | "scored"
  >,
  calls?: Pick<CallRollup, "connected" | "not_connected">,
) {
  const applicable = a.business_achieved + a.business_partial + a.business_not_achieved;
  return {
    pass_rate: rate(a.passed, a.passed + a.failed),
    system_goal_rate: rate(a.system_pass, a.system_pass + a.system_fail),
    business_goal_rate: rate(a.business_achieved, applicable),
    partial_share: rate(a.business_partial, applicable),
    average_score: a.scored > 0 ? round(a.score_sum / a.scored, 1) : null,
    connect_rate: calls ? rate(calls.connected, calls.connected + calls.not_connected) : null,
  };
}

/** Milliseconds from `now` to the next `hour`:00 IST (strictly after `now`), for the nightly rebuild. */
export function msUntilIstHour(now: Date, hour: number): number {
  const ist = now.getTime() + IST_OFFSET_MS;
  const todayAt = Math.floor(ist / DAY_MS) * DAY_MS + hour * 3_600_000;
  return (todayAt > ist ? todayAt : todayAt + DAY_MS) - ist;
}

/** Every IST day from `from` to `to`, both included (none when `from` is later). */
export function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  const end = istDayRange(to).from.getTime();
  for (let t = istDayRange(from).from.getTime(); t <= end; t += DAY_MS) days.push(istDay(new Date(t)));
  return days;
}

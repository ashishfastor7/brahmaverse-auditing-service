import { agreement, gate, GATE, type Pair, type Ratio } from "./agreement";
import { CHECK_CODES, expectedFor, type GoldenRow, verdictOf } from "./golden";

const CHECK_NAME: Record<(typeof CHECK_CODES)[number], string> = {
  S1: "S1 Connected",
  S2: "S2 Conversation handled",
  S3: "S3 Flow completed",
  S4: "S4 Data saved",
};

/** Below this share a parameter needs improvement (the same bar as the switch-over gate). */
const ATTENTION = GATE.agreement;
/** Fewer calls than this never get a parameter named as weak: one disagreement isn't a finding. */
const MIN_BASE = 5;
/** Under this many calls the whole report is an early signal (PRD §6). */
const STEADY_CALLS = 30;

/** `needs_improvement`: under the bar, on enough calls to mean something. The report's first insight names these. */
export type ReportParameter = Ratio & { key: string; label: string; needs_improvement: boolean };

/** The dashboard's "AI judge evaluation" report: no call text, so it can be downloaded and shared. */
export type JudgeReport = {
  generated_at: string;
  /** Golden calls measured, of which blind spot-checks. */
  calls: number;
  blind_calls: number;
  /** Some calls, but too few for the numbers to have settled. */
  early_signal: boolean;
  /** Every decision compared, pooled: each pass/fail, outcome, failure-code set, check and metric counts once. */
  overall: Ratio;
  /** The same, on blind spot-checks only: the reviewer hadn't seen the judge's answer. */
  blind: Ratio;
  /** Lowest agreement first. */
  parameters: ReportParameter[];
  insights: string[];
  gate_met: boolean;
  judge_prompt_versions: string[];
};

const pooled = (ratios: Ratio[]): Ratio => {
  const agree = ratios.reduce((s, r) => s + r.agree, 0);
  const total = ratios.reduce((s, r) => s + r.total, 0);
  return { agree, total, rate: total ? agree / total : null };
};
const pct = (rate: number | null) => `${Math.round((rate ?? 0) * 100)}%`;

/**
 * The report over the golden set as audited: each reviewer's answer against the stored audit they reviewed. Unlike
 * `eval:v2` it doesn't re-run the judge, so it costs nothing and shows how the judge did on real calls at the prompt
 * versions it ran on. Rows whose audit has no result can't be measured and are left out. Pure.
 */
export function judgeReport(rows: GoldenRow[], conditionLabels: Record<string, string>, generatedAt: Date): JudgeReport {
  const measured = rows.filter((r) => r.audit);
  const pairs: Pair[] = measured.map((row) => ({ call_id: row.call_id, kind: row.kind, expected: expectedFor(row), verdict: verdictOf(row.audit!) }));
  const blindPairs = pairs.filter((p) => p.kind === "blind");
  const all = agreement(pairs);
  const blindAll = agreement(blindPairs);
  const metricNames = new Map(measured.flatMap((r) => r.audit!.metrics.map((m) => [m.key, m.name] as const)));

  const parameters: ReportParameter[] = [
    { ...all.pass_fail, key: "pass_fail", label: "Pass/fail" },
    { ...all.business_outcome, key: "business_outcome", label: "Business outcome" },
    { ...all.failure_code_sets, key: "failure_codes", label: "Failure conditions" },
    ...CHECK_CODES.map((c) => ({ ...(all.checks[c] ?? { agree: 0, total: 0, rate: null }), key: `check:${c}`, label: CHECK_NAME[c] })),
    ...Object.entries(all.metrics).map(([key, r]) => ({ ...r, key: `metric:${key}`, label: metricNames.get(key) ?? key })),
  ]
    .filter((p) => p.total > 0)
    .map((p) => ({ ...p, needs_improvement: p.total >= MIN_BASE && p.rate! < ATTENTION }))
    .sort((a, b) => a.rate! - b.rate! || a.label.localeCompare(b.label));

  const insights: string[] = [];
  if (pairs.length > 0) {
    const weak = parameters.filter((p) => p.needs_improvement).slice(0, 3);
    insights.push(
      weak.length
        ? `Needs improvement: ${weak.map((p) => `${p.label} (${pct(p.rate)}, ${p.agree} of ${p.total})`).join("; ")}.`
        : `No parameter with at least ${MIN_BASE} calls is below ${pct(ATTENTION)}.`,
    );
    const label = (code: string) => conditionLabels[code] ?? code;
    const wrong = Object.entries(all.codes).filter(([, c]) => c.fp > 0).sort(([, a], [, b]) => b.fp - a.fp).slice(0, 2);
    for (const [code, c] of wrong) insights.push(`${label(code)} was flagged wrongly in ${c.fp} of ${c.tp + c.fp} flagged calls.`);
    const missed = Object.entries(all.codes).filter(([, c]) => c.fn > 0).sort(([, a], [, b]) => b.fn - a.fn).slice(0, 2);
    for (const [code, c] of missed) insights.push(`${label(code)} was missed in ${c.fn} of ${c.tp + c.fn} calls where reviewers found it.`);
    if (pairs.length < STEADY_CALLS) insights.push(`Early signal: only ${pairs.length} Golden Set ${pairs.length === 1 ? "call" : "calls"}, and these numbers settle at about ${STEADY_CALLS}.`);
    const seen = pairs.length - blindPairs.length;
    if (seen > 0) insights.push(`${seen} of ${pairs.length} calls were reviewed after seeing the audit, which can lift agreement. Blind spot-checks are the independent measure.`);
  }
  const switchGate = gate(blindPairs);
  insights.push(
    switchGate.met
      ? "The switch-over gate is met on these blind spot-checks, as audited."
      : `Switch-over gate not met yet: ${blindPairs.length} of ${GATE.blind} blind spot-checks, and it needs ${pct(GATE.agreement)} agreement.`,
  );

  return {
    generated_at: generatedAt.toISOString(),
    calls: pairs.length,
    blind_calls: blindPairs.length,
    early_signal: pairs.length > 0 && pairs.length < STEADY_CALLS,
    overall: pooled(parameters),
    blind: pooled([blindAll.pass_fail, blindAll.business_outcome, blindAll.failure_code_sets]),
    parameters,
    insights,
    gate_met: switchGate.met,
    judge_prompt_versions: [...new Set(measured.map((r) => r.audit!.judge.prompt_version))].sort(),
  };
}

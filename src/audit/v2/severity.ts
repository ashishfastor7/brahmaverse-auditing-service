import type { ScorecardCondition } from "./config";
import type { MetricResult } from "./score";

/** A failure condition flagged on a call, by a rule or by the judge. */
export type Flag = { code: string; source: "rule" | "judge"; evidence: unknown[] };

export type DropReason = "no_evidence" | "not_on_scorecard" | "disabled";

/** What each kept flag did; `dropped` lists the flags that count for nothing. */
export type FlagOutcome = {
  critical: string[];
  major: { code: string; metric: string | null }[];
  minor: string[];
  dropped: { code: string; reason: DropReason }[];
};

/**
 * P0-8, PRD §4.5: applies the scorecard's severity to each flag. Critical codes fail the call (`computeScore`), a
 * Major flag sets its linked metric (`scorecard_condition.metric_key`) to 0 unless that metric is N/A, and a Minor
 * flag is only counted.
 *
 * Dropped: a judge flag without evidence, a code the scorecard doesn't have, and a disabled condition. Rule flags
 * need no evidence (`CALL_ERROR` and `NO_AGENT_SPEECH` have no turn to cite). Each code counts once; a rule hit wins
 * over the judge reporting the same code.
 */
export function applySeverity(
  flags: Flag[],
  conditions: Pick<ScorecardCondition, "condition_code" | "enabled" | "severity" | "metric_key">[],
  metricResults: MetricResult[],
): FlagOutcome & { results: MetricResult[] } {
  const outcome: FlagOutcome = { critical: [], major: [], minor: [], dropped: [] };
  const ruleCodes = new Set(flags.filter((f) => f.source === "rule").map((f) => f.code));
  const counted = new Set<string>();

  for (const f of flags) {
    if (counted.has(f.code) || (f.source === "judge" && ruleCodes.has(f.code))) continue;
    const condition = conditions.find((c) => c.condition_code === f.code);
    const reason: DropReason | null = !condition
      ? "not_on_scorecard"
      : !condition.enabled
        ? "disabled"
        : f.source === "judge" && f.evidence.length === 0
          ? "no_evidence"
          : null;
    if (reason) {
      outcome.dropped.push({ code: f.code, reason });
      continue;
    }
    counted.add(f.code);
    if (condition!.severity === "critical") outcome.critical.push(f.code);
    else if (condition!.severity === "major") outcome.major.push({ code: f.code, metric: condition!.metric_key });
    else outcome.minor.push(f.code);
  }

  const zeroed = new Set(outcome.major.map((m) => m.metric));
  return { ...outcome, results: metricResults.map((r) => (zeroed.has(r.key) && !r.n_a ? { ...r, score: 0 } : r)) };
}

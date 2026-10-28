import type { Metric, ScorecardCondition, ScorecardHeader } from "./config";
import { type Flag, type FlagOutcome, applySeverity } from "./severity";

/** A metric's raw score from the judge or a rule, as stored in `metric_result`. */
export type MetricResult = { key: string; score: number | null; max: number; n_a: boolean };

export type FailedBy =
  | { kind: "below_threshold" }
  | { kind: "auto_fail"; metric: string }
  | { kind: "critical"; code: string }
  /** Every metric was N/A or weighted 0, so there is nothing to score. */
  | { kind: "no_score" };

export type Score = { score: number | null; passed: boolean; failedBy: FailedBy[] };

/** Metrics that count toward the score: not N/A, scored, and weighted above 0 (a missing weight is 0). */
const applicable = (metricResults: MetricResult[], weights: Record<string, number>) =>
  metricResults.filter((m) => !m.n_a && m.score !== null && (weights[m.key] ?? 0) > 0);

/**
 * P0-6, PRD §4.2: 100 × Σ w·s/m ÷ Σ w over the applicable metrics, rounded to one decimal. N/A metrics and metrics
 * weighted 0 drop out, so the remaining weights are re-normalised. Null when no metric is applicable.
 */
export function weightedScore(metricResults: MetricResult[], weights: Record<string, number>): number | null {
  const counted = applicable(metricResults, weights);
  if (counted.length === 0) return null;
  const totalWeight = counted.reduce((sum, m) => sum + weights[m.key]!, 0);
  return Math.round((1000 * counted.reduce((sum, m) => sum + (weights[m.key]! * m.score!) / m.max, 0)) / totalWeight) / 10;
}

/** P0-6, PRD §4.2: a call passes only at or above the threshold, with no auto-fail metric at 0 and no Critical flag. */
export function passes(score: number | null, threshold: number, autoFailZero: boolean, criticalFlagged: boolean): boolean {
  return score !== null && score >= threshold && !autoFailZero && !criticalFlagged;
}

/**
 * The score of one audit: the scorecard's severities applied to the flags (`applySeverity`: Critical fails the call,
 * Major zeroes its linked metric, Minor is counted only), then `weightedScore` and `passes`, with every reason the call
 * failed and what each flag did. A clean call under the threshold fails. The threshold is checked on the rounded
 * score, so the score shown and the verdict always agree.
 */
export function computeScore(
  metricResults: MetricResult[],
  weights: Record<string, number>,
  scorecard: Pick<ScorecardHeader, "pass_threshold"> & {
    metrics: Pick<Metric, "key" | "auto_fail">[];
    conditions: Pick<ScorecardCondition, "condition_code" | "enabled" | "severity" | "metric_key">[];
  },
  flags: Flag[] = [],
): Score & { flags: FlagOutcome } {
  const { results, ...outcome } = applySeverity(flags, scorecard.conditions, metricResults);
  const score = weightedScore(results, weights);
  const autoFail = new Set(scorecard.metrics.filter((m) => m.auto_fail).map((m) => m.key));
  const zeroed = applicable(results, weights).filter((m) => autoFail.has(m.key) && m.score === 0);

  const failedBy: FailedBy[] = [];
  if (score === null) failedBy.push({ kind: "no_score" });
  else if (score < scorecard.pass_threshold) failedBy.push({ kind: "below_threshold" });
  for (const m of zeroed) failedBy.push({ kind: "auto_fail", metric: m.key });
  for (const code of outcome.critical) failedBy.push({ kind: "critical", code });
  const passed = passes(score, scorecard.pass_threshold, zeroed.length > 0, outcome.critical.length > 0);
  return { score, passed, failedBy, flags: outcome };
}

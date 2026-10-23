import type { Metric, ScorecardHeader } from "./config";

/** A metric's raw score from the judge or a rule, as stored in `metric_result` (Major flags already applied). */
export type MetricResult = { key: string; score: number | null; max: number; n_a: boolean };

export type FailedBy =
  | { kind: "below_threshold" }
  | { kind: "auto_fail"; metric: string }
  | { kind: "critical"; code: string }
  /** Every metric was N/A or weighted 0, so there is nothing to score. */
  | { kind: "no_score" };

export type Score = { score: number | null; passed: boolean; failedBy: FailedBy[] };

/**
 * P0-6, PRD §4.2: score = 100 × Σ w·s/m ÷ Σ w over the applicable metrics, rounded to one decimal. N/A metrics and
 * metrics weighted 0 (or missing from `weights`) drop out, so the remaining weights are re-normalised.
 *
 * The call passes only if the score is at or above the scorecard's threshold, no auto-fail metric scored 0 and no
 * Critical condition was flagged; `failedBy` lists every reason it didn't. A clean call under the threshold fails.
 * The threshold is checked on the rounded score, so the score shown and the verdict always agree.
 */
export function computeScore(
  metricResults: MetricResult[],
  weights: Record<string, number>,
  scorecard: Pick<ScorecardHeader, "pass_threshold"> & { metrics: Pick<Metric, "key" | "auto_fail">[] },
  criticalFlags: string[] = [],
): Score {
  const applicable = metricResults.filter((m) => !m.n_a && m.score !== null && (weights[m.key] ?? 0) > 0);
  const totalWeight = applicable.reduce((sum, m) => sum + weights[m.key]!, 0);
  const score =
    applicable.length === 0
      ? null
      : Math.round((1000 * applicable.reduce((sum, m) => sum + (weights[m.key]! * m.score!) / m.max, 0)) / totalWeight) / 10;

  const failedBy: FailedBy[] = [];
  if (score === null) failedBy.push({ kind: "no_score" });
  else if (score < scorecard.pass_threshold) failedBy.push({ kind: "below_threshold" });
  const autoFail = new Set(scorecard.metrics.filter((m) => m.auto_fail).map((m) => m.key));
  for (const m of applicable) if (autoFail.has(m.key) && m.score === 0) failedBy.push({ kind: "auto_fail", metric: m.key });
  for (const code of criticalFlags) failedBy.push({ kind: "critical", code });
  return { score, passed: failedBy.length === 0, failedBy };
}

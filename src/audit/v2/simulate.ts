import type { Metric, ScorecardVersion } from "./config";
import { type MetricResult, computeScore } from "./score";
import type { Flag } from "./severity";

/** A completed v2 audit as stored: its raw metric results (by key) and its failure flags. */
export type StoredAudit = { id: number; call_id: number; results: MetricResult[]; flags: Flag[] };

/** What a scorecard version's defaults would make of the audits: pass threshold, weights, auto-fail and severities. */
export type SimulatedConfig = Pick<ScorecardVersion, "version" | "pass_threshold" | "conditions"> & {
  metrics: Pick<Metric, "key" | "weight" | "auto_fail">[];
};

type Side = { passed: number; pass_rate: number | null; average_score: number | null };
type Verdict = { score: number | null; passed: boolean };

export type Simulation = {
  audits: number;
  before: Side & { version: number };
  after: Side & { version: number };
  /** Audits whose pass/fail changes, the ones that would now fail first. */
  flipped: { audit_id: number; call_id: number; before: Verdict; after: Verdict }[];
  /** Audits whose score changes at all. */
  score_changed: number;
  /** Metrics the draft weights above 0 that some audits never scored (weight 0 when audited): N/A for those audits. */
  unscored: { audits: number; metrics: string[] };
};

const weightsOf = (c: SimulatedConfig) => Object.fromEntries(c.metrics.map((m) => [m.key, m.weight]));
const round1 = (n: number) => Math.round(n * 10) / 10;

function side(verdicts: Verdict[], version: number): Side & { version: number } {
  const passed = verdicts.filter((v) => v.passed).length;
  const scores = verdicts.map((v) => v.score).filter((s): s is number => s !== null);
  return {
    version,
    passed,
    pass_rate: verdicts.length ? round1((100 * passed) / verdicts.length) : null,
    average_score: scores.length ? round1(scores.reduce((sum, s) => sum + s, 0) / scores.length) : null,
  };
}

/**
 * P1-20, PRD §8 #3: how the pass rate of stored audits would move if a scorecard draft were published. Both sides are
 * re-scored from the same stored metric results with `computeScore` (no judge call): `before` with the published
 * version, `after` with the draft. So the difference is only the draft's change, even when the audits were run with
 * other slider weights. A metric an audit never scored (it was weighted 0) is left out of that audit on both sides, as
 * `computeScore` does, and counted in `unscored`. Pure.
 */
export function simulateScorecard(audits: StoredAudit[], published: SimulatedConfig, draft: SimulatedConfig): Simulation {
  const beforeWeights = weightsOf(published);
  const afterWeights = weightsOf(draft);
  const rows = audits.map((a) => {
    const before = computeScore(a.results, beforeWeights, published, a.flags);
    const after = computeScore(a.results, afterWeights, draft, a.flags);
    return { audit: a, before: { score: before.score, passed: before.passed }, after: { score: after.score, passed: after.passed } };
  });

  const unscoredMetrics = new Set<string>();
  let unscoredAudits = 0;
  for (const a of audits) {
    const missing = draft.metrics.filter((m) => m.weight > 0 && !a.results.some((r) => r.key === m.key)).map((m) => m.key);
    if (missing.length) unscoredAudits++;
    for (const k of missing) unscoredMetrics.add(k);
  }

  return {
    audits: audits.length,
    before: side(
      rows.map((r) => r.before),
      published.version,
    ),
    after: side(
      rows.map((r) => r.after),
      draft.version,
    ),
    flipped: rows
      .filter((r) => r.before.passed !== r.after.passed)
      .sort((x, y) => Number(x.after.passed) - Number(y.after.passed))
      .map((r) => ({ audit_id: r.audit.id, call_id: r.audit.call_id, before: r.before, after: r.after })),
    score_changed: rows.filter((r) => r.before.score !== r.after.score).length,
    unscored: { audits: unscoredAudits, metrics: draft.metrics.map((m) => m.key).filter((k) => unscoredMetrics.has(k)) },
  };
}

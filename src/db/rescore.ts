import { type MetricResult, type Score, computeScore } from "@/audit/v2/score";
import { QueryTypes, type Sequelize } from "sequelize";
import type { ScorecardCondition } from "@/audit/v2/config";
import { loadScorecard } from "./config-store";

/** Why an audit can't be re-scored with these weights; the route answers with `status`. */
export class RescoreError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409,
  ) {
    super(message);
  }
}

type StoredFlag = { condition_code: string; severity: string };

/**
 * A re-score's inputs from the stored flags: each Major flag zeroes its linked metric (`scorecard_condition.metric_key`)
 * unless that metric is N/A, and Critical flags are returned for `computeScore`. Minor flags change nothing. Doing the
 * zeroing again works whether the stored metric score is the judge's raw one or already zeroed.
 */
export function applyStoredFlags(
  results: MetricResult[],
  flags: StoredFlag[],
  conditions: Pick<ScorecardCondition, "condition_code" | "metric_key">[],
): { results: MetricResult[]; critical: string[] } {
  const zeroed = new Set(
    flags
      .filter((f) => f.severity === "major")
      .map((f) => conditions.find((c) => c.condition_code === f.condition_code)?.metric_key)
      .filter((key) => key != null),
  );
  return {
    results: results.map((r) => (zeroed.has(r.key) && !r.n_a ? { ...r, score: 0 } : r)),
    critical: flags.filter((f) => f.severity === "critical").map((f) => f.condition_code),
  };
}

/**
 * PRD §4.4 re-score: the score a completed v2 audit gets with other weights, recomputed from its stored
 * `metric_result` rows and failure flags (`applyStoredFlags`). No judge call and nothing written; `saveRescore` stores it.
 *
 * Returns null for a missing audit or one not written by the v2 engine. Throws `RescoreError`:
 * - 409 when the audit isn't completed (it has no metric results);
 * - 400 when `weights` uses a metric outside the audit's scorecard, has a negative weight or more than one decimal,
 *   doesn't total 100, or weights a metric this audit didn't score (it was at 0, so the judge skipped it; only a
 *   re-audit can score it).
 */
export async function rescoreAudit(
  db: Sequelize,
  auditId: number,
  weights: Record<string, number>,
): Promise<(Score & { weights: Record<string, number> }) | null> {
  const select = <T extends object>(sql: string) => db.query<T>(sql, { bind: [auditId], type: QueryTypes.SELECT });
  const [audit] = await select<{ status: string; scorecard_id: string | null; scorecard_version: number | null }>(
    "SELECT status, scorecard_id, scorecard_version FROM audit_results WHERE id = $1 AND engine = 'v2'",
  );
  if (!audit) return null;
  if (audit.status !== "completed" || !audit.scorecard_id || audit.scorecard_version === null)
    throw new RescoreError(`audit ${auditId} is ${audit.status}; only completed audits can be re-scored`, 409);
  const scorecard = (await loadScorecard(db, audit.scorecard_id, audit.scorecard_version))!;

  const keys = scorecard.metrics.map((m) => m.key);
  for (const [key, weight] of Object.entries(weights)) {
    if (!keys.includes(key))
      throw new RescoreError(`unknown metric ${key} for scorecard ${audit.scorecard_id} version ${audit.scorecard_version}`, 400);
    if (!(weight >= 0)) throw new RescoreError(`${key} has a negative weight`, 400);
    if (Math.abs(weight * 10 - Math.round(weight * 10)) > 1e-9) throw new RescoreError(`${key} has more than one decimal`, 400);
  }
  const total = Object.values(weights).reduce((sum, w) => sum + Math.round(w * 10), 0);
  if (total !== 1000) throw new RescoreError(`weights total ${total / 10}, not 100`, 400);

  const stored = await select<MetricResult>(
    `SELECT m.key, r.score::float8 AS score, r.max::float8 AS max, r.n_a
       FROM metric_result r JOIN metric m ON m.id = r.metric_id WHERE r.audit_id = $1`,
  );
  const unscored = keys.filter((k) => (weights[k] ?? 0) > 0 && !stored.some((r) => r.key === k));
  if (unscored.length)
    throw new RescoreError(`${unscored.join(", ")} weren't scored in this audit (weight 0 when audited); re-audit to weight them`, 400);

  const flags = await select<StoredFlag>("SELECT condition_code, severity FROM failure_flag WHERE audit_id = $1 ORDER BY id");
  const { results, critical } = applyStoredFlags(stored, flags, scorecard.conditions);
  return { ...computeScore(results, weights, scorecard, critical), weights };
}

export type Rescore = Score & { id: number; audit_id: number; weights_used: Record<string, number>; created_by: string; created_at: Date };

/**
 * P1-9: re-scores a v2 audit (`rescoreAudit`) and stores it in `audit_rescore`, the audit's re-score history. The
 * audit row is not changed, so dashboards keep counting the score it was audited with. Null when `rescoreAudit` is.
 */
export async function saveRescore(
  db: Sequelize,
  auditId: number,
  weights: Record<string, number>,
  created_by: string,
): Promise<Rescore | null> {
  const result = await rescoreAudit(db, auditId, weights);
  if (!result) return null;
  const [row] = await db.query<Rescore>(
    `INSERT INTO audit_rescore (audit_id, weights_used, score, passed, failed_by, created_by) VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, audit_id, weights_used, score::float8 AS score, passed, failed_by AS "failedBy", created_by, created_at`,
    {
      bind: [auditId, JSON.stringify(result.weights), result.score, result.passed, JSON.stringify(result.failedBy), created_by],
      type: QueryTypes.SELECT,
    },
  );
  return row!;
}

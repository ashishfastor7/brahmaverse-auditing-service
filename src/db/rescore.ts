import { type MetricResult, type Score, computeScore } from "@/audit/v2/score";
import { QueryTypes, type Sequelize } from "sequelize";
import { loadScorecard } from "./config-store";

/**
 * PRD §4.4 re-score: the score a v2 audit gets with other weights, recomputed from its stored `metric_result` rows
 * and failure flags. No judge call and nothing written; storing a re-score (and its route) is P1-9.
 *
 * Major flags zero their linked metric (`scorecard_condition.metric_key`) again here, so this works whether the stored
 * score is the judge's raw one or already zeroed. Returns null for a missing audit or one not written by the v2 engine.
 * Throws if `weights` uses a metric outside the audit's scorecard, has a negative weight or doesn't total 100.
 */
export async function rescoreAudit(
  db: Sequelize,
  auditId: number,
  weights: Record<string, number>,
): Promise<(Score & { weights: Record<string, number> }) | null> {
  const select = <T extends object>(sql: string) => db.query<T>(sql, { bind: [auditId], type: QueryTypes.SELECT });
  const [audit] = await select<{ scorecard_id: string | null; scorecard_version: number | null }>(
    "SELECT scorecard_id, scorecard_version FROM audit_results WHERE id = $1 AND engine = 'v2'",
  );
  if (!audit?.scorecard_id || audit.scorecard_version === null) return null;
  const scorecard = (await loadScorecard(db, audit.scorecard_id, audit.scorecard_version))!;

  const keys = scorecard.metrics.map((m) => m.key);
  for (const [key, weight] of Object.entries(weights)) {
    if (!keys.includes(key))
      throw new Error(`unknown metric ${key} for scorecard ${audit.scorecard_id} version ${audit.scorecard_version}`);
    if (!(weight >= 0)) throw new Error(`${key} has a negative weight`);
  }
  const total = Object.values(weights).reduce((sum, w) => sum + Math.round(w * 10), 0);
  if (total !== 1000) throw new Error(`weights total ${total / 10}, not 100`);

  const results = await select<MetricResult>(
    `SELECT m.key, r.score::float8 AS score, r.max::float8 AS max, r.n_a
       FROM metric_result r JOIN metric m ON m.id = r.metric_id WHERE r.audit_id = $1`,
  );
  const flags = await select<{ condition_code: string; severity: string }>(
    "SELECT condition_code, severity FROM failure_flag WHERE audit_id = $1 ORDER BY id",
  );
  const zeroed = new Set(
    flags
      .filter((f) => f.severity === "major")
      .map((f) => scorecard.conditions.find((c) => c.condition_code === f.condition_code)?.metric_key)
      .filter((key) => key != null),
  );
  const critical = flags.filter((f) => f.severity === "critical").map((f) => f.condition_code);
  const scored = results.map((r) => (zeroed.has(r.key) && !r.n_a ? { ...r, score: 0 } : r));
  return { ...computeScore(scored, weights, scorecard, critical), weights };
}

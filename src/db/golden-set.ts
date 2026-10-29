import type { GoldenRow } from "@/audit/v2/eval/golden";
import { QueryTypes, type Sequelize } from "sequelize";

/**
 * The golden set (P1-19, migration 0013): per call, its latest agree / dispute review of a v2 audit (flags don't count),
 * kept only when that review is `in_golden_set`, so retiring the latest review drops the call. Oldest first.
 */
export async function loadGoldenSet(db: Sequelize): Promise<GoldenRow[]> {
  const rows = await db.query<GoldenRow & { created_at: Date | string }>(
    `SELECT * FROM (
       SELECT DISTINCT ON (a.source, a.call_id)
         r.id AS review_id, r.audit_id, a.call_id, a.agent_code, r.kind, r.verdict, r.note, r.created_at,
         r.in_golden_set, r.expected_pass_fail, r.expected_business_outcome, r.expected_failure_codes, r.corrected_scores,
         r.corrected_checks, a.result AS audit
       FROM review r JOIN audit_results a ON a.id = r.audit_id
       WHERE a.engine = 'v2' AND r.verdict IN ('agree', 'dispute')
       ORDER BY a.source, a.call_id, r.created_at DESC, r.id DESC
     ) latest
     WHERE in_golden_set
     ORDER BY created_at, review_id`,
    { type: QueryTypes.SELECT },
  );
  return rows.map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString() }));
}

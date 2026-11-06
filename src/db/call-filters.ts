import { QueryTypes, type Sequelize } from "sequelize";

/** The v2 audit filters (`GET /calls?engine=v2`), as the dashboard links them. */
export type V2CallFilters = {
  success?: "PASS" | "FAIL";
  system_goal?: "PASS" | "FAIL" | "NOT_APPLICABLE";
  business_goal?: "ACHIEVED" | "PARTIAL" | "NOT_ACHIEVED" | "NOT_APPLICABLE" | "APPLICABLE";
  bucket?: "success" | "business_miss" | "ai_failure" | "achieved_despite_ai" | "na";
  /** `scorecard_id@version` */
  scorecard?: string;
  /** `agent_code@version` */
  goal_version?: string;
  failure_code?: string;
  needs_review?: "true" | "false";
  min_score?: number;
  /** Exclusive, so histogram bins don't overlap. */
  max_score?: number;
  business_reason?: string;
  check?: "S1" | "S2" | "S3" | "S4";
  /** A system check that didn't fail (passed or N/A): the funnel's "conversation completed" is `S2`. */
  check_ok?: "S1" | "S2" | "S3" | "S4";
  metric_lost?: string;
  audit?: "audited" | "not_audited";
};

/**
 * v2 audit-side filters on each call's current v2 audit (completed, not superseded), as the dashboard counts them:
 * the matching call ids, or null when no v2 filter is set.
 */
export async function v2CallIds(db: Sequelize, q: V2CallFilters): Promise<number[] | null> {
  const where = ["engine = 'v2'", "status = 'completed'", "superseded_by IS NULL", "source = 'voice_call_logs'"];
  const bind: unknown[] = [];
  const one = (sql: string, value: unknown) => {
    bind.push(value);
    where.push(sql.replaceAll("?", `$${bind.length}`));
  };
  const before = where.length;
  if (q.success) one("success_result = ?", q.success);
  if (q.system_goal) one("system_goal = ?", q.system_goal);
  if (q.business_goal === "APPLICABLE") where.push("business_goal IN ('ACHIEVED', 'PARTIAL', 'NOT_ACHIEVED')");
  else if (q.business_goal) one("business_goal = ?", q.business_goal);
  if (q.bucket) where.push(BUCKET_SQL[q.bucket]);
  if (q.scorecard) {
    const [id, v] = q.scorecard.split("@");
    one("scorecard_id = ?", id);
    one("scorecard_version = ?", Number(v));
  }
  if (q.goal_version) one("coalesce(goal_version, 0) = ?", Number(q.goal_version.split("@")[1]));
  if (q.failure_code) one("? = ANY(failure_codes)", q.failure_code);
  if (q.needs_review) one("needs_review = ?", q.needs_review === "true");
  if (q.min_score !== undefined) one("score >= ?", q.min_score);
  if (q.max_score !== undefined) one("score < ?", q.max_score);
  if (q.business_reason) {
    where.push("business_goal = 'NOT_ACHIEVED'");
    one("coalesce(nullif(business_reason, ''), 'UNSPECIFIED') = ?", q.business_reason);
  }
  if (q.check) one("EXISTS (SELECT 1 FROM audit_check c WHERE c.audit_id = audit_results.id AND c.check_code = ? AND c.result = 'FAIL')", q.check);
  if (q.check_ok)
    one("NOT EXISTS (SELECT 1 FROM audit_check c WHERE c.audit_id = audit_results.id AND c.check_code = ? AND c.result = 'FAIL')", q.check_ok);
  if (q.metric_lost)
    one(
      `EXISTS (SELECT 1 FROM metric_result r JOIN metric m ON m.id = r.metric_id
                WHERE r.audit_id = audit_results.id AND m.key = ? AND NOT r.n_a AND r.score < r.max)`,
      q.metric_lost,
    );
  if (where.length === before && q.audit !== "audited") return null;
  const rows = await db.query<{ call_id: number }>(
    `SELECT call_id FROM audit_results WHERE ${where.join(" AND ")}`,
    { bind, type: QueryTypes.SELECT },
  );
  return rows.map((r) => r.call_id);
}

const BUCKET_SQL: Record<string, string> = {
  success: "system_goal = 'PASS' AND business_goal = 'ACHIEVED'",
  business_miss: "system_goal = 'PASS' AND business_goal IN ('PARTIAL', 'NOT_ACHIEVED')",
  ai_failure: "system_goal = 'FAIL' AND business_goal IN ('PARTIAL', 'NOT_ACHIEVED')",
  achieved_despite_ai: "system_goal = 'FAIL' AND business_goal = 'ACHIEVED'",
  na: "(system_goal IS NULL OR system_goal = 'NOT_APPLICABLE' OR business_goal IS NULL OR business_goal = 'NOT_APPLICABLE')",
};

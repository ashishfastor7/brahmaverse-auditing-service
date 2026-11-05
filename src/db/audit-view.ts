import type { AuditResultV2 } from "@/audit/v2/audit-call";
import type { BusinessOutcome, MetricRubric, Severity } from "@/audit/v2/config";
import type { ReviewInput, ReviewTarget } from "@/audit/v2/review";
import { QueryTypes, type Sequelize, type Transaction } from "sequelize";
import { loadGoalConfig, loadScorecard } from "./config-store";

/**
 * Read side of the v2 call page (PRD §5, P2-1, P2-3, P2-4): one v2 audit with what's needed to explain it (the metric
 * rubrics, condition definitions, the goal's outcomes), the call's audit history, and the audit's reviews.
 */

export type AuditRowView = {
  id: number;
  call_id: number;
  source: string;
  agent_code: string | null;
  status: "pending" | "completed" | "failed" | "skipped";
  skip_reason: string | null;
  error: string | null;
  score: number | null;
  success_result: "PASS" | "FAIL" | null;
  needs_review: boolean;
  scorecard_id: string | null;
  scorecard_version: number | null;
  goal_version: number | null;
  weights_used: Record<string, number> | null;
  judge_model: string | null;
  judge_prompt_version: string | null;
  triggered_by: string | null;
  trigger_mode: string | null;
  cost: number | null;
  latency_ms: number | null;
  superseded_by: number | null;
  created_at: string;
  audited_at: string | null;
  result: AuditResultV2 | null;
};

export type MetricDefinition = {
  key: string;
  name: string;
  description: string;
  rubric: MetricRubric;
  applicability: string;
  method: string;
  weight: number;
  scale: number;
  auto_fail: boolean;
};
export type ConditionView = { code: string; label: string; definition: string; severity: Severity | null; enabled: boolean };

export type AuditContext = {
  scorecard: { scorecard_id: string; version: number; name: string; pass_threshold: number } | null;
  metrics: MetricDefinition[];
  /** The scorecard's conditions plus any flagged code it doesn't list (the rule codes), with their definitions. */
  conditions: ConditionView[];
  goal: { name: string; description: string; outcomes: BusinessOutcome[]; reason_codes: Partial<Record<BusinessOutcome, string[]>> } | null;
};

export type HistoryEntry = Pick<
  AuditRowView,
  | "id"
  | "status"
  | "score"
  | "success_result"
  | "scorecard_id"
  | "scorecard_version"
  | "goal_version"
  | "weights_used"
  | "judge_model"
  | "judge_prompt_version"
  | "triggered_by"
  | "trigger_mode"
  | "superseded_by"
  | "created_at"
  | "audited_at"
> & {
  rescores: { id: number; score: number | null; passed: boolean; weights_used: Record<string, number>; created_by: string; created_at: string }[];
};

export type ReviewRow = {
  id: number;
  audit_id: number;
  reviewer: string;
  kind: "normal" | "blind";
  verdict: "agree" | "dispute" | "flag";
  note: string | null;
  item_notes: Record<string, string> | null;
  corrected_scores: Record<string, number | null> | null;
  corrected_checks: Record<string, string> | null;
  expected_pass_fail: "PASS" | "FAIL" | null;
  expected_business_outcome: BusinessOutcome | null;
  expected_failure_codes: string[] | null;
  created_at: string;
};

export type AuditView = { audit: AuditRowView; context: AuditContext; history: HistoryEntry[]; reviews: ReviewRow[] };

const select = <T extends object>(db: Sequelize, sql: string, bind: unknown[], transaction?: Transaction) =>
  db.query<T>(sql, { bind, type: QueryTypes.SELECT, transaction });

const ROW = `id, call_id, source, agent_code, status, skip_reason, error, score::float8 AS score, success_result, needs_review,
  scorecard_id, scorecard_version, goal_version, weights_used, judge_model, judge_prompt_version, triggered_by, trigger_mode,
  cost::float8 AS cost, latency_ms, superseded_by, created_at, audited_at, result`;

/** A v2 audit by id, or null (missing, or a v1 row). */
export async function loadAuditRow(db: Sequelize, id: number): Promise<AuditRowView | null> {
  const [row] = await select<AuditRowView>(db, `SELECT ${ROW} FROM audit_results WHERE id = $1 AND engine = 'v2'`, [id]);
  return row ?? null;
}

/**
 * The call's current v2 audit: the completed one nothing supersedes. A newer run that failed, is pending or was skipped
 * leaves it current (`runAuditV2`); when the call has no completed audit, its latest attempt.
 */
export async function currentAuditId(db: Sequelize, source: string, callId: number): Promise<number | null> {
  const [row] = await select<{ id: number }>(
    db,
    `SELECT id FROM audit_results WHERE engine = 'v2' AND source = $1 AND call_id = $2
      ORDER BY (status = 'completed' AND superseded_by IS NULL) DESC, id DESC LIMIT 1`,
    [source, callId],
  );
  return row?.id ?? null;
}

export const offeredOutcomes = (partialSuccess: string[]): BusinessOutcome[] => [
  "ACHIEVED",
  ...(partialSuccess.length ? (["PARTIAL"] as const) : []),
  "NOT_ACHIEVED",
  "NOT_APPLICABLE",
];

/** The scorecard version, goal and condition definitions an audit was graded with. */
export async function loadAuditContext(db: Sequelize, audit: Pick<AuditRowView, "scorecard_id" | "scorecard_version" | "goal_version" | "agent_code" | "result">): Promise<AuditContext> {
  const [sc, goal] = await Promise.all([
    audit.scorecard_id && audit.scorecard_version !== null ? loadScorecard(db, audit.scorecard_id, audit.scorecard_version) : null,
    audit.agent_code && audit.goal_version !== null ? loadGoalConfig(db, audit.agent_code, audit.goal_version) : null,
  ]);
  const flagged = (audit.result?.flags ?? []).map((f) => f.code);
  const codes = [...new Set([...(sc?.conditions.map((c) => c.condition_code) ?? []), ...flagged])];
  const library = await select<{ code: string; label: string; definition: string }>(
    db,
    "SELECT code, label, definition FROM failure_condition WHERE code = ANY($1) ORDER BY code",
    [codes],
  );
  return {
    scorecard: sc ? { scorecard_id: sc.scorecard_id, version: sc.version, name: sc.name, pass_threshold: Number(sc.pass_threshold) } : null,
    metrics: (sc?.metrics ?? []).map((m) => ({
      key: m.key,
      name: m.name,
      description: m.description,
      rubric: m.rubric,
      applicability: m.applicability,
      method: m.method,
      weight: Number(m.weight),
      scale: m.scale,
      auto_fail: m.auto_fail,
    })),
    conditions: library.map((l) => {
      const on = sc?.conditions.find((c) => c.condition_code === l.code);
      return { ...l, severity: on?.severity ?? null, enabled: on?.enabled ?? false };
    }),
    goal: goal
      ? { name: goal.name, description: goal.description, outcomes: offeredOutcomes(goal.partial_success), reason_codes: goal.reason_codes }
      : null,
  };
}

/** PRD §5 item 8: every v2 audit of the call, newest first, each with its re-scores. */
export async function loadAuditHistory(db: Sequelize, source: string, callId: number): Promise<HistoryEntry[]> {
  const audits = await select<Omit<HistoryEntry, "rescores">>(
    db,
    `SELECT id, status, score::float8 AS score, success_result, scorecard_id, scorecard_version, goal_version, weights_used,
       judge_model, judge_prompt_version, triggered_by, trigger_mode, superseded_by, created_at, audited_at
     FROM audit_results WHERE engine = 'v2' AND source = $1 AND call_id = $2 ORDER BY id DESC`,
    [source, callId],
  );
  const rescores = await select<HistoryEntry["rescores"][number] & { audit_id: number }>(
    db,
    `SELECT id, audit_id, score::float8 AS score, passed, weights_used, created_by, created_at
       FROM audit_rescore WHERE audit_id = ANY($1) ORDER BY created_at DESC, id DESC`,
    [audits.map((a) => a.id)],
  );
  return audits.map((a) => ({ ...a, rescores: rescores.filter((r) => r.audit_id === a.id).map(({ audit_id: _, ...r }) => r) }));
}

const REVIEW = `id, audit_id, reviewer, kind, verdict, note, item_notes, corrected_scores, corrected_checks, expected_pass_fail,
  expected_business_outcome, expected_failure_codes, created_at`;

export function loadReviews(db: Sequelize, auditId: number, kind?: "normal" | "blind"): Promise<ReviewRow[]> {
  return select<ReviewRow>(
    db,
    `SELECT ${REVIEW} FROM review WHERE audit_id = $1 ${kind ? "AND kind = $2" : ""} ORDER BY created_at DESC, id DESC`,
    kind ? [auditId, kind] : [auditId],
  );
}

/** Everything the call page shows for one v2 audit, or null for a missing or v1 audit. */
export async function loadAuditView(db: Sequelize, id: number): Promise<AuditView | null> {
  const audit = await loadAuditRow(db, id);
  if (!audit) return null;
  const [context, history, reviews] = await Promise.all([
    loadAuditContext(db, audit),
    loadAuditHistory(db, audit.source, audit.call_id),
    loadReviews(db, audit.id, "normal"),
  ]);
  return { audit, context, history, reviews };
}

/** What `validateReview` checks a review against: the audit as stored, and the codes its scorecard could flag. */
export function reviewTarget(audit: AuditRowView, context: AuditContext): ReviewTarget | null {
  const r = audit.result;
  if (audit.status !== "completed" || !r) return null;
  return {
    metrics: r.metrics.map((m) => ({ key: m.key, max: m.max, score: m.score, n_a: m.n_a })),
    checks: r.checks,
    business_outcome: r.business_goal?.outcome ?? null,
    outcomes: context.goal?.outcomes ?? offeredOutcomes([]),
    failure_codes: r.flags.map((f) => f.code),
    known_codes: [...new Set([...context.conditions.map((c) => c.code), "CALL_ERROR", "NO_AGENT_SPEECH"])],
  };
}

export type BlindFields = Pick<ReviewRow, "expected_pass_fail" | "expected_business_outcome" | "expected_failure_codes">;

/** Saves one review; `kind = 'blind'` reviews come only from the spot-check route. */
export async function insertReview(
  db: Sequelize,
  auditId: number,
  reviewer: string,
  kind: "normal" | "blind",
  input: ReviewInput & Partial<BlindFields>,
  transaction?: Transaction,
): Promise<ReviewRow> {
  const json = (v: unknown) => (v === undefined || v === null || (typeof v === "object" && Object.keys(v as object).length === 0) ? null : JSON.stringify(v));
  const [row] = await select<ReviewRow>(
    db,
    `INSERT INTO review (audit_id, reviewer, kind, verdict, note, item_notes, corrected_scores, corrected_checks, expected_pass_fail,
       expected_business_outcome, expected_failure_codes)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11) RETURNING ${REVIEW}`,
    [
      auditId,
      reviewer,
      kind,
      input.verdict,
      input.note?.trim() || null,
      json(input.item_notes),
      json(input.corrected_scores),
      json(input.corrected_checks),
      input.expected_pass_fail ?? null,
      input.expected_business_outcome ?? null,
      input.expected_failure_codes ?? null,
    ],
    transaction,
  );
  return row!;
}

import type { AuditInput, AuditResult } from "@/audit/types";
import { sequelize } from "@/db/connection";
import { type CreationOptional, DataTypes, type InferAttributes, type InferCreationAttributes, Model } from "sequelize";

/**
 * One audit of one call under one rubric version. The call itself is snapshotted into `call`, so
 * the dashboard never needs to read another service's database; re-auditing under a new rubric
 * version adds a row instead of overwriting the old score.
 *
 * Headline fields are copied out of `result` into columns so the call list can filter and sort on them.
 *
 * The table itself is created and changed only by `src/db/migrations/`; keep this definition in step with them.
 */
interface AuditResultModel extends Model<InferAttributes<AuditResultModel>, InferCreationAttributes<AuditResultModel>> {
  id: CreationOptional<number>;
  engine: CreationOptional<"v1" | "v2">;
  source: string;
  call_id: number;
  business_id: number;
  agent_id: number | null;
  agent_code: string | null;
  rubric_version: string;
  status: "pending" | "completed" | "failed" | "skipped";
  skip_reason: string | null;
  error: string | null;

  overall_score: number | null;
  quality_score: number | null;
  success_result: "PASS" | "FAIL" | null;
  goal_result: "ACHIEVED" | "NOT_ACHIEVED" | "NOT_APPLICABLE" | null;
  goal_reason_code: string | null;
  failure_codes: CreationOptional<string[]>;
  auditor_confidence: number | null;
  needs_review: CreationOptional<boolean>;

  result: AuditResult | null;
  call: AuditInput;

  judge_model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number | null;
  call_created_at: Date | null;
  audited_at: Date | null;
  created_at: CreationOptional<Date>;
  updated_at: CreationOptional<Date>;

  // v2 only (migration 0006). On v1 rows only scorecard_id/scorecard_version are set: the 5 × 20 template they used.
  triggered_by: CreationOptional<string | null>;
  trigger_mode: CreationOptional<"single" | "selected" | "filter" | "sample" | null>;
  batch_id: CreationOptional<number | null>;
  goal_version: CreationOptional<number | null>;
  scorecard_id: CreationOptional<string | null>;
  scorecard_version: CreationOptional<number | null>;
  weights_used: CreationOptional<Record<string, number> | null>;
  system_goal: CreationOptional<"PASS" | "FAIL" | "NOT_APPLICABLE" | null>;
  business_goal: CreationOptional<"ACHIEVED" | "PARTIAL" | "NOT_ACHIEVED" | "NOT_APPLICABLE" | null>;
  business_reason: CreationOptional<string | null>;
  judge_prompt_version: CreationOptional<string | null>;
  /** USD, as a string (Postgres NUMERIC). */
  cost: CreationOptional<string | null>;
  superseded_by: CreationOptional<number | null>;
  /** v2 score, one decimal (migration 0009), as a string (Postgres NUMERIC). */
  score: CreationOptional<string | null>;
}

export type AuditResultRow = AuditResultModel["_model"]["dataValues"];

/** Spread into every v1 query: v1 code never reads or overwrites rows written by the v2 engine. */
export const V1 = { engine: "v1" } as const;

/** Columns v1 responses never include (with `engine`), so the v1 API returns what it returned before v2. */
export const V2_FIELDS = [
  "triggered_by",
  "trigger_mode",
  "batch_id",
  "goal_version",
  "scorecard_id",
  "scorecard_version",
  "weights_used",
  "system_goal",
  "business_goal",
  "business_reason",
  "judge_prompt_version",
  "cost",
  "superseded_by",
  "score",
] as const;
export const V1_EXCLUDED = ["engine", ...V2_FIELDS];
/** A row as the v1 routes returned it before v2: without the v2 fields. */
export const withoutV2Fields = (row: AuditResultRow) =>
  Object.fromEntries(Object.entries(row).filter(([k]) => !(V2_FIELDS as readonly string[]).includes(k)));

export const AuditResultTable = sequelize.define<AuditResultModel>(
  "audit_results",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    engine: { type: DataTypes.STRING, allowNull: false, defaultValue: "v1" },
    source: { type: DataTypes.STRING, allowNull: false },
    call_id: { type: DataTypes.INTEGER, allowNull: false },
    business_id: { type: DataTypes.INTEGER, allowNull: false },
    agent_id: { type: DataTypes.INTEGER },
    agent_code: { type: DataTypes.STRING },
    rubric_version: { type: DataTypes.STRING, allowNull: false },
    status: { type: DataTypes.STRING, allowNull: false, defaultValue: "pending" },
    skip_reason: { type: DataTypes.STRING },
    error: { type: DataTypes.TEXT },

    overall_score: { type: DataTypes.INTEGER },
    quality_score: { type: DataTypes.INTEGER },
    success_result: { type: DataTypes.STRING },
    goal_result: { type: DataTypes.STRING },
    goal_reason_code: { type: DataTypes.STRING },
    failure_codes: { type: DataTypes.ARRAY(DataTypes.STRING), allowNull: false, defaultValue: [] },
    auditor_confidence: { type: DataTypes.FLOAT },
    needs_review: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },

    result: { type: DataTypes.JSONB },
    call: { type: DataTypes.JSONB, allowNull: false },

    judge_model: { type: DataTypes.STRING },
    input_tokens: { type: DataTypes.INTEGER },
    output_tokens: { type: DataTypes.INTEGER },
    latency_ms: { type: DataTypes.INTEGER },
    call_created_at: { type: DataTypes.DATE },
    audited_at: { type: DataTypes.DATE },
    created_at: { type: DataTypes.DATE },
    updated_at: { type: DataTypes.DATE },

    triggered_by: { type: DataTypes.STRING },
    trigger_mode: { type: DataTypes.STRING },
    batch_id: { type: DataTypes.INTEGER },
    goal_version: { type: DataTypes.INTEGER },
    scorecard_id: { type: DataTypes.STRING },
    scorecard_version: { type: DataTypes.INTEGER },
    weights_used: { type: DataTypes.JSONB },
    system_goal: { type: DataTypes.STRING },
    business_goal: { type: DataTypes.STRING },
    business_reason: { type: DataTypes.STRING },
    judge_prompt_version: { type: DataTypes.STRING },
    cost: { type: DataTypes.DECIMAL(12, 6) },
    superseded_by: { type: DataTypes.INTEGER },
    score: { type: DataTypes.DECIMAL(4, 1) },
  },
  {
    tableName: "audit_results",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: "updated_at",
    indexes: [
      // v1 only (migration 0012): v2 re-audits add rows; the current one has no superseded_by
      { unique: true, fields: ["source", "call_id", "rubric_version"], where: { engine: "v1" } },
      { fields: ["agent_code", "call_created_at"] },
      { fields: ["business_id", "call_created_at"] },
      { fields: ["status"] },
    ],
  },
);

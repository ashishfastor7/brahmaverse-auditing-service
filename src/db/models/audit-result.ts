import type { AuditInput, AuditResult } from "@/audit/types";
import { sequelize } from "@/db/connection";
import { type CreationOptional, DataTypes, type InferAttributes, type InferCreationAttributes, Model } from "sequelize";

/**
 * One audit of one call under one rubric version. The call itself is snapshotted into `call`, so
 * the dashboard never needs to read another service's database; re-auditing under a new rubric
 * version adds a row instead of overwriting the old score.
 *
 * Headline fields are copied out of `result` into columns so the call list can filter and sort on them.
 */
interface AuditResultModel extends Model<InferAttributes<AuditResultModel>, InferCreationAttributes<AuditResultModel>> {
  id: CreationOptional<number>;
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
}

export type AuditResultRow = AuditResultModel["_model"]["dataValues"];

export const AuditResultTable = sequelize.define<AuditResultModel>(
  "audit_results",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
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
  },
  {
    tableName: "audit_results",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: "updated_at",
    indexes: [
      { unique: true, fields: ["source", "call_id", "rubric_version"] },
      { fields: ["agent_code", "call_created_at"] },
      { fields: ["business_id", "call_created_at"] },
      { fields: ["status"] },
    ],
  },
);

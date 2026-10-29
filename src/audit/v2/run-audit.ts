import { normalizeCall } from "@/audit/normalize";
import { agentFor } from "@/audit/rubrics";
import { skipReason } from "@/audit/rules";
import type { AgentPrompt, AuditInput } from "@/audit/types";
import { loadActiveConfig, loadConditionDefinitions } from "@/db/config-store";
import { env } from "@/env";
import { readAgentInstructions } from "@/services/v2/agent-instructions";
import { type CallerFlow, readCallerFlow } from "@/services/v2/caller-flow";
import { callRefs } from "@/services/v2/call-refs";
import type { Judge } from "@/audit/audit-call";
import { createOpenAIJudge } from "@/audit/judge/openai-judge";
import { QueryTypes, type Sequelize, type Transaction } from "sequelize";
import { type AuditResultV2, auditCallV2 } from "./audit-call";
import { type CallRecord, toCallRecord } from "./call-record";
import { type GoalConfig, MIN_METRICS, type ScorecardVersion } from "./config";
import { type ConditionDefinition, JUDGE_PROMPT_VERSION } from "./judge/prompt";
import { judgeCost } from "./cost";
import { validateWeights } from "./score";

/** A request the v2 audit can't run as asked (bad weights); the route answers 400. */
export class AuditRequestError extends Error {}

/** Everything one v2 audit needs, read from the call row, this service's config and the other services' readers. */
export type AuditContextV2 = {
  input: AuditInput;
  record: CallRecord;
  agentLabel: string | null;
  scorecard: ScorecardVersion;
  goal: GoalConfig;
  weights: Record<string, number>;
  definitions: ConditionDefinition[];
  instructions: AgentPrompt | null;
  /** Why the instructions are missing, when they are (P0-10 reader). */
  instructionsMissing: string | null;
  flow: CallerFlow;
};

export type ContextOrSkip = { context: AuditContextV2; skip: null } | { context: null; skip: string; input: AuditInput };

/**
 * Pipeline step 1 for one call: resolves the agent's published scorecard and goal (`loadActiveConfig`), the weights for
 * this run (the scorecard's defaults unless given; `validateWeights`), the enabled conditions' definitions, and the
 * readers (instructions, then the flow, falling back to the prompt text). A call that can't be audited (not completed,
 * playground, no transcript, no config) is a skip with the reason. Throws on weights it can't use.
 */
export async function loadAuditContextV2(db: Sequelize, raw: any, opts: { weights?: Record<string, number> } = {}): Promise<ContextOrSkip> {
  const base = normalizeCall(raw);
  // agent_code is missing on many call rows; resolve it from agent_id, as v1 does
  const agent = agentFor(base.agent_code, base.agent_id);
  const input: AuditInput = { ...base, agent_code: agent?.code ?? base.agent_code };
  const skip = skipReason(input, { includePlayground: env.AUDIT_INCLUDE_PLAYGROUND });
  if (skip) return { context: null, skip, input };

  const config = await loadActiveConfig(db, input.agent_code, input.agent_id);
  if (config.reason !== null) return { context: null, skip: config.reason.toUpperCase(), input };
  const { scorecard, goal } = config;
  if (scorecard.metrics.length < MIN_METRICS) {
    throw new Error(`scorecard ${scorecard.scorecard_id} v${scorecard.version} has ${scorecard.metrics.length} metrics; v2 needs at least ${MIN_METRICS}`);
  }
  const weights = opts.weights ?? Object.fromEntries(scorecard.metrics.map((m) => [m.key, m.weight]));
  const weightErrors = validateWeights(weights, scorecard.metrics.map((m) => m.key));
  if (weightErrors.length) throw new AuditRequestError(`weights can't be used: ${weightErrors.join("; ")}`);

  const enabled = scorecard.conditions.filter((c) => c.enabled).map((c) => c.condition_code);
  const refs = callRefs(raw);
  const instructions = await readAgentInstructions(refs);
  const flow = await readCallerFlow(refs, instructions.value?.system_prompt ?? null);
  return {
    context: {
      input,
      record: toCallRecord(raw),
      agentLabel: agent?.label ?? null,
      scorecard,
      goal,
      weights,
      definitions: await loadConditionDefinitions(db, enabled),
      instructions: instructions.value,
      instructionsMissing: instructions.reason === null ? null : `${instructions.reason}: ${instructions.detail}`,
      flow,
    },
    skip: null,
  };
}

let defaultJudge: Judge | null = null;
/** The production v2 judge: the pinned model from AUDIT_V2_JUDGE_MODEL, returning non-JSON replies raw so they can be retried. */
export function v2Judge(): { judge: Judge; model: string } {
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
  if (!env.AUDIT_V2_JUDGE_MODEL) throw new Error("AUDIT_V2_JUDGE_MODEL is not set (a dated model id)");
  defaultJudge ??= createOpenAIJudge({
    apiKey: env.OPENAI_API_KEY,
    model: env.AUDIT_V2_JUDGE_MODEL,
    reasoningEffort: env.AUDIT_V2_JUDGE_REASONING_EFFORT,
    rawOnInvalidJson: true,
  });
  return { judge: defaultJudge, model: env.AUDIT_V2_JUDGE_MODEL };
}

export type TriggerMode = "single" | "selected" | "filter" | "sample";
export type RunOptionsV2 = {
  weights?: Record<string, number>;
  /** Re-audit even when the current audit used the same scorecard, goal, weights, prompt version and model. */
  force?: boolean;
  /** Tests pass a fixture judge (and the model it stands for); production uses `v2Judge()`. */
  judge?: { judge: Judge; model: string };
  triggeredBy: string;
  triggerMode: TriggerMode;
  batchId?: number | null;
};

export type AuditRowV2 = {
  id: number;
  call_id: number;
  status: "pending" | "completed" | "failed" | "skipped";
  skip_reason: string | null;
  error: string | null;
  score: number | null;
  success_result: "PASS" | "FAIL" | null;
  system_goal: string | null;
  business_goal: string | null;
  business_reason: string | null;
  needs_review: boolean;
  judge_model: string | null;
  judge_prompt_version: string | null;
  /** USD, null when the model has no price in `JUDGE_PRICES`. */
  cost: number | null;
  superseded_by: number | null;
  result: AuditResultV2 | null;
};

const ROW = `id, call_id, status, skip_reason, error, score::float8 AS score, success_result, system_goal, business_goal,
  business_reason, needs_review, judge_model, judge_prompt_version, cost::float8 AS cost, superseded_by, result`;
const HEADLINE = "source, call_id, business_id, agent_id, agent_code, call, call_created_at, triggered_by, trigger_mode, batch_id";

/** Runs SQL and returns its rows (also for `INSERT … RETURNING`). */
const rows = <T extends object>(db: Sequelize, sql: string, bind: unknown[], transaction?: Transaction) =>
  db.query<T>(sql, { bind, type: QueryTypes.SELECT, transaction });

/**
 * P1-8, PRD §7: audits one call with the v2 engine and stores it as an `engine = 'v2'` row with its checks, metric
 * results and flags. Only ever started by a user action (route, replay).
 *
 * - Every run inserts a new row. When it completes, the call's previous current rows get `superseded_by` = this one,
 *   in one transaction under a per-call advisory lock; the history stays. A judge error marks only the new row
 *   `failed`, so the previous audit stays current.
 * - Idempotent unless `force`: when the current completed audit used the same scorecard version, goal version,
 *   weights, judge prompt version and model, it is returned as is.
 * - A call that can't be audited is stored as `skipped` with the reason, and supersedes nothing.
 */
export async function runAuditV2(db: Sequelize, raw: any, opts: RunOptionsV2): Promise<AuditRowV2> {
  const loaded = await loadAuditContextV2(db, raw, { weights: opts.weights });
  const input = loaded.context ? loaded.context.input : loaded.input;
  const headline = [
    input.source,
    input.call_id,
    input.business_id,
    input.agent_id,
    input.agent_code,
    JSON.stringify(input),
    input.call_created_at,
    opts.triggeredBy,
    opts.triggerMode,
    opts.batchId ?? null,
  ];

  if (!loaded.context) {
    const [row] = await rows<AuditRowV2>(
      db,
      `INSERT INTO audit_results (engine, rubric_version, status, skip_reason, audited_at, created_at, updated_at, ${HEADLINE})
       VALUES ('v2', 'v2', 'skipped', $1, now(), now(), now(), $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11) RETURNING ${ROW}`,
      [loaded.skip, ...headline],
    );
    return row!;
  }

  const { context } = loaded;
  const { judge, model } = opts.judge ?? v2Judge();
  const sc = context.scorecard;
  const versions = [sc.scorecard_id, sc.version, context.goal.version, JSON.stringify(context.weights), JUDGE_PROMPT_VERSION, model];
  if (!opts.force) {
    const [same] = await rows<AuditRowV2>(
      db,
      `SELECT ${ROW} FROM audit_results
        WHERE engine = 'v2' AND source = $1 AND call_id = $2 AND superseded_by IS NULL AND status = 'completed'
          AND scorecard_id = $3 AND scorecard_version = $4 AND goal_version = $5 AND weights_used = $6::jsonb
          AND judge_prompt_version = $7 AND judge_model = $8
        ORDER BY id DESC LIMIT 1`,
      [input.source, input.call_id, ...versions],
    );
    if (same) return same;
  }

  // judge_model is the configured id until the judge answers, then the id the API reports
  const [pending] = await rows<{ id: number }>(
    db,
    `INSERT INTO audit_results (engine, rubric_version, status, scorecard_id, scorecard_version, goal_version, weights_used,
       judge_prompt_version, judge_model, created_at, updated_at, ${HEADLINE})
     VALUES ('v2', $1, 'pending', $2, $3, $4, $5::jsonb, $6, $7, now(), now(), $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16, $17)
     RETURNING id`,
    [`v2:${sc.scorecard_id}@${sc.version}`, ...versions, ...headline],
  );
  const id = pending!.id;

  const started = Date.now();
  let audited: Awaited<ReturnType<typeof auditCallV2>>;
  try {
    audited = await auditCallV2(context.input, context.record, { ...context, judge, reviewThreshold: env.AUDIT_REVIEW_THRESHOLD });
  } catch (e) {
    await db.query("UPDATE audit_results SET status = 'failed', error = $2, latency_ms = $3, updated_at = now() WHERE id = $1", {
      bind: [id, (e as Error).message, Date.now() - started],
    });
    console.error(`[audit v2] call=${input.call_id} failed: ${(e as Error).message}`);
    throw e;
  }
  const { result, usage } = audited;

  await db.transaction(async (transaction) => {
    await db.query("SELECT pg_advisory_xact_lock($1)", { bind: [input.call_id], transaction });
    await db.query(
      `UPDATE audit_results SET status = 'completed', score = $2, success_result = $3, system_goal = $4, business_goal = $5,
         business_reason = $6, failure_codes = $7, auditor_confidence = $8, needs_review = $9, result = $10::jsonb,
         judge_model = $11, input_tokens = $12, output_tokens = $13, latency_ms = $14, cost = $15, audited_at = now(),
         updated_at = now()
       WHERE id = $1`,
      {
        bind: [
          id,
          result.score,
          result.passed === null ? null : result.passed ? "PASS" : "FAIL",
          result.system_goal.result,
          result.business_goal?.outcome ?? null,
          result.business_goal?.reason_code ?? null,
          result.flags.map((f) => f.code),
          result.auditor_confidence,
          result.needs_review,
          JSON.stringify(result),
          result.judge.model,
          usage.input_tokens,
          usage.output_tokens,
          Date.now() - started,
          judgeCost(result.judge.model, usage),
        ],
        transaction,
      },
    );
    for (const [code, c] of Object.entries(result.checks)) {
      await db.query("INSERT INTO audit_check (audit_id, check_code, result, reason, evidence) VALUES ($1, $2, $3, $4, $5::jsonb)", {
        bind: [id, code, c.result, c.reason, JSON.stringify(c.evidence)],
        transaction,
      });
    }
    for (const m of result.metrics) {
      const metricId = sc.metrics.find((x) => x.key === m.key)!.id;
      await db.query(
        "INSERT INTO metric_result (audit_id, metric_id, score, max, n_a, reason, evidence) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)",
        { bind: [id, metricId, m.score, m.max, m.n_a, m.reason, JSON.stringify(m.evidence)], transaction },
      );
    }
    for (const f of result.flags) {
      await db.query(
        "INSERT INTO failure_flag (audit_id, condition_code, severity, source, reason, evidence) VALUES ($1, $2, $3, $4, $5, $6::jsonb)",
        { bind: [id, f.code, f.severity, f.source, f.reason, JSON.stringify(f.evidence)], transaction },
      );
    }
    await db.query(
      `UPDATE audit_results SET superseded_by = $1, updated_at = now()
        WHERE engine = 'v2' AND source = $2 AND call_id = $3 AND superseded_by IS NULL AND id <> $1`,
      { bind: [id, input.source, input.call_id], transaction },
    );
  });

  console.log(
    `[audit v2] call=${input.call_id} ${sc.scorecard_id}@${sc.version} score=${result.score} passed=${result.passed} ` +
      `system=${result.system_goal.result} business=${result.business_goal?.outcome ?? "-"} review=${result.needs_review} ` +
      `ms=${Date.now() - started}`,
  );
  const [row] = await rows<AuditRowV2>(db, `SELECT ${ROW} FROM audit_results WHERE id = $1`, [id]);
  return row!;
}

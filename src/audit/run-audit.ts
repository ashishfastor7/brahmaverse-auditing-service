import { tables } from "@/db";
import type { AuditResultRow } from "@/db/models/audit-result";
import { env } from "@/env";
import { fetchAgentPrompt } from "@/services/prompt.service";
import { auditCall, type Judge } from "./audit-call";
import { createOpenAIJudge } from "./judge/openai-judge";
import { skipReason } from "./rules";
import { rubricFor } from "./rubrics";
import type { AuditInput } from "./types";

let judge: Judge | null = null;
function defaultJudge(): Judge {
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
  return (judge ??= createOpenAIJudge({
    apiKey: env.OPENAI_API_KEY,
    model: env.AUDIT_JUDGE_MODEL,
    reasoningEffort: env.AUDIT_JUDGE_REASONING_EFFORT,
  }));
}

const headline = (input: AuditInput) => ({
  source: input.source,
  call_id: input.call_id,
  business_id: input.business_id,
  agent_id: input.agent_id,
  agent_code: input.agent_code,
  call: input,
  call_created_at: input.call_created_at ? new Date(input.call_created_at) : null,
});

/**
 * Audits one call and stores the result. Idempotent per (call, rubric version): a call already
 * audited under the current rubric is left alone unless `force`, so a redelivered event is free.
 * Throws when the judge fails, after recording the failure, so a bus consumer retries.
 */
export async function runAudit(input: AuditInput, opts: { force?: boolean; judge?: Judge } = {}): Promise<AuditResultRow> {
  const rubric = rubricFor(input.agent_code);
  const key = { source: input.source, call_id: input.call_id, rubric_version: rubric.version };
  let row = await tables.AuditResult.findOne({ where: key });

  if (row && row.status === "completed" && !opts.force) return row.get({ plain: true });

  const skip = skipReason(input, { includePlayground: env.AUDIT_INCLUDE_PLAYGROUND });
  if (skip) {
    const values = { ...headline(input), ...key, status: "skipped" as const, skip_reason: skip, error: null, audited_at: new Date() };
    row = row ? await row.update(values) : await tables.AuditResult.create(values);
    return row.get({ plain: true });
  }

  const pending = { ...headline(input), ...key, status: "pending" as const, skip_reason: null, error: null };
  row = row ? await row.update(pending) : await tables.AuditResult.create(pending);

  const started = Date.now();
  try {
    const agentPrompt = await fetchAgentPrompt(input);
    const { result, usage } = await auditCall(input, {
      judge: opts.judge ?? defaultJudge(),
      rubric,
      agentPrompt,
      reviewThreshold: env.AUDIT_REVIEW_THRESHOLD,
    });
    await row.update({
      status: "completed",
      overall_score: result.overall_score,
      quality_score: result.quality_score,
      success_result: result.call_success.result,
      goal_result: result.call_goal.result,
      goal_reason_code: result.call_goal.reason_code,
      failure_codes: result.call_success.failure_reasons.map((f) => f.code),
      auditor_confidence: result.auditor_confidence,
      needs_review: result.needs_review,
      result,
      judge_model: result.judge.model,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      latency_ms: Date.now() - started,
      audited_at: new Date(),
    });
    console.log(
      `[audit] call=${input.call_id} agent=${input.agent_code} rubric=${rubric.version} score=${result.overall_score} ` +
        `success=${result.call_success.result} goal=${result.call_goal.result} confidence=${result.auditor_confidence} ` +
        `ms=${Date.now() - started}`,
    );
    return row.get({ plain: true });
  } catch (e) {
    await row.update({ status: "failed", error: (e as Error).message, latency_ms: Date.now() - started });
    console.error(`[audit] call=${input.call_id} failed: ${(e as Error).message}`);
    throw e;
  }
}

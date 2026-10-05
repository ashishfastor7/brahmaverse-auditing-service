import { validateEvidence } from "./evidence";
import { buildJudgeMessages } from "./judge/prompt";
import { judgeJsonSchema, judgeOutputSchema } from "./judge/schema";
import { ruleFailures } from "./rules";
import type { Rubric } from "./rubrics";
import { auditorConfidence, overallScore, qualityScore } from "./score";
import type { AgentPrompt, AuditInput, AuditResult, FailureReason, MetricResult } from "./types";

export type JudgeCall = {
  messages: ReturnType<typeof buildJudgeMessages>;
  schema: ReturnType<typeof judgeJsonSchema>;
};
export type JudgeResponse = { output: unknown; model: string; usage: { input_tokens: number; output_tokens: number } };
/** Anything that can grade a call — OpenAI in production, a stub in tests. */
export type Judge = (call: JudgeCall) => Promise<JudgeResponse>;

export type AuditOutcome = { result: AuditResult; usage: JudgeResponse["usage"] };

/**
 * Rule checks + LLM judge → the audit result. Pure apart from the judge call, so it is the unit
 * the tests and the planted-defect eval exercise; persistence lives in `run-audit.ts`.
 */
export async function auditCall(
  input: AuditInput,
  deps: { judge: Judge; rubric: Rubric; agentPrompt: AgentPrompt | null; reviewThreshold: number },
): Promise<AuditOutcome> {
  const { rubric, agentPrompt } = deps;

  const response = await deps.judge({
    messages: buildJudgeMessages(input, rubric, agentPrompt),
    schema: judgeJsonSchema(rubric),
  });
  const output = judgeOutputSchema.parse(response.output);

  // Every rubric dimension must be scored exactly once, or the weighted score is meaningless.
  const metrics: Record<string, MetricResult> = {};
  for (const d of output.dimensions) {
    if (!rubric.dimensions.some((r) => r.key === d.key)) continue;
    metrics[d.key] = {
      applicable: d.applicable,
      score: d.applicable ? d.score : null,
      reasoning: d.reasoning,
      evidence: d.evidence.map((e) => ({ ...e })),
    };
  }
  const missing = rubric.dimensions.filter((d) => !metrics[d.key]).map((d) => d.key);
  if (missing.length > 0) throw new Error(`judge did not score dimensions: ${missing.join(", ")}`);

  const knownFailureCodes = new Set(rubric.failure_conditions.map((f) => f.code));
  const llmFailures: FailureReason[] = output.failures
    .filter((f, i, all) => knownFailureCodes.has(f.code) && all.findIndex((g) => g.code === f.code) === i)
    .map((f) => ({ code: f.code, source: "llm", explanation: f.explanation, turn: f.turn, quote: f.quote }));
  // A rule hit wins over the LLM reporting the same code: it is deterministic.
  const rules = ruleFailures(input, rubric);
  const failures = [...rules, ...llmFailures.filter((f) => !rules.some((r) => r.code === f.code))];

  const goalEvidence = output.goal.evidence.map((e) => ({ ...e }));
  const wentWell = output.went_well.map((w) => ({ ...w }));
  const wentWrong = output.went_wrong.map((w) => ({ ...w }));
  const llmFailureEvidence = failures.filter((f) => f.source === "llm" && f.quote) as { turn: number; quote: string }[];

  const cited = [
    ...Object.values(metrics).flatMap((m) => m.evidence),
    ...goalEvidence,
    ...wentWell,
    ...wentWrong,
    ...llmFailureEvidence,
  ];
  const evidenceValidity = validateEvidence(input.transcript, cited);

  // A goal reason code from the wrong bucket (e.g. CALLBACK_REQUESTED with ACHIEVED) is replaced
  // by that bucket's first code rather than stored inconsistent.
  const bucket = rubric.goal.reason_codes[output.goal.result];
  const reasonCode = bucket.includes(output.goal.reason_code) ? output.goal.reason_code : bucket[0];

  const failed = failures.length > 0;
  const quality = qualityScore(rubric, metrics);
  const confidence = auditorConfidence({
    selfConfidence: output.confidence,
    evidenceValidity,
    transcriptQuality: output.transcript_quality.rating,
    hadAgentPrompt: agentPrompt !== null,
  });

  const result: AuditResult = {
    overall_score: overallScore(rubric, quality, failed),
    quality_score: quality,
    call_success: { result: failed ? "FAIL" : "PASS", failure_reasons: failures },
    call_goal: { result: output.goal.result, reason_code: reasonCode, explanation: output.goal.explanation, evidence: goalEvidence },
    metrics,
    went_well: wentWell,
    went_wrong: wentWrong,
    sentiment: output.sentiment,
    verdict: output.verdict,
    auditor_confidence: confidence,
    needs_review: confidence < deps.reviewThreshold,
    rubric_version: rubric.version,
    judge: {
      model: response.model,
      prompt_used: agentPrompt ? { prompt_code: agentPrompt.prompt_code, version: agentPrompt.version } : null,
      transcript_quality: output.transcript_quality.rating,
      evidence_validity: Math.round(evidenceValidity * 100) / 100,
      self_confidence: output.confidence,
    },
  };
  return { result, usage: response.usage };
}

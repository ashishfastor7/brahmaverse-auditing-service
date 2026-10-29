import { validateEvidence } from "./evidence";
import { buildJudgeMessages } from "./judge/prompt";
import { judgeJsonSchema, judgeOutputSchema } from "./judge/schema";
import { ruleFailures } from "./rules";
import type { Rubric } from "./rubrics";
import { JUDGE_SCALE, POINTS_PER_CATEGORY, SCORECARD } from "./rubrics/types";
import { auditorConfidence, overallScore, qualityScore } from "./score";
import type { AgentPrompt, AuditInput, AuditResult, FailureReason, MetricResult } from "./types";

export type JudgeMessage = { role: "system" | "user" | "assistant"; content: string };
/** One judge request: v1's (`buildJudgeMessages`, `judgeJsonSchema`) or v2's (`src/audit/v2/judge/`). */
export type JudgeCall = { messages: JudgeMessage[]; schema: Record<string, unknown>; schemaName?: string };
/** `output` is the parsed JSON; with `rawOnInvalidJson` (v2) a reply that isn't JSON comes back as its raw string. */
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
  deps: { judge: Judge; rubric: Rubric; agentPrompt: AgentPrompt | null; reviewThreshold: number; agentLabel?: string | null },
): Promise<AuditOutcome> {
  const { rubric, agentPrompt } = deps;
  const agentLabel = deps.agentLabel ?? null;

  const response = await deps.judge({
    messages: buildJudgeMessages(input, rubric, agentPrompt, agentLabel),
    schema: judgeJsonSchema(rubric),
  });
  const output = judgeOutputSchema.parse(response.output);

  // Every scorecard category must be scored exactly once, or the total is meaningless.
  const metrics: Record<string, MetricResult> = {};
  for (const { key, label } of SCORECARD) {
    const c = output.scorecard.find((s) => s.key === key);
    if (!c) continue;
    metrics[key] = {
      label,
      applicable: c.applicable,
      score: c.applicable ? Math.round((c.score / JUDGE_SCALE) * POINTS_PER_CATEGORY) : null,
      max: POINTS_PER_CATEGORY,
      reasoning: c.reasoning,
      evidence: c.evidence.map((e) => ({ ...e })),
    };
  }
  const missing = SCORECARD.filter((c) => !metrics[c.key]).map((c) => c.key);
  if (missing.length > 0) throw new Error(`judge did not score categories: ${missing.join(", ")}`);

  const knownFailureCodes = new Set(rubric.failure_conditions.map((f) => f.code));
  const llmFailures: FailureReason[] = output.failures
    .filter((f, i, all) => knownFailureCodes.has(f.code) && all.findIndex((g) => g.code === f.code) === i)
    .map((f) => {
      const evidence = [...f.evidence].sort((x, y) => x.turn - y.turn).map((e) => ({ ...e }));
      return { code: f.code, source: "llm", explanation: f.explanation, evidence, turn: evidence[0]?.turn ?? null, quote: evidence[0]?.quote ?? null };
    });
  // A rule hit wins over the LLM reporting the same code: it is deterministic.
  const rules = ruleFailures(input, rubric);
  const failures = [...rules, ...llmFailures.filter((f) => !rules.some((r) => r.code === f.code))];

  const goalEvidence = output.goal.evidence.map((e) => ({ ...e }));
  const wentWell = output.went_well.map((w) => ({ ...w }));
  const improvements = output.improvements.map((w) => ({ ...w }));
  const llmFailureEvidence = failures.filter((f) => f.source === "llm").flatMap((f) => f.evidence);

  const cited = [
    ...Object.values(metrics).flatMap((m) => m.evidence),
    ...goalEvidence,
    ...wentWell,
    ...improvements,
    ...llmFailureEvidence,
  ];
  const evidenceValidity = validateEvidence(input.transcript, cited);
  // Keep the first-evidence shortcut in step with any turn the validator corrected.
  for (const f of failures) if (f.evidence[0]) ((f.turn = f.evidence[0].turn), (f.quote = f.evidence[0].quote));

  // A goal reason code from the wrong bucket (e.g. CALLBACK_REQUESTED with ACHIEVED) is replaced
  // by that bucket's first code rather than stored inconsistent.
  const bucket = rubric.goal.reason_codes[output.goal.result];
  const reasonCode = bucket.includes(output.goal.reason_code) ? output.goal.reason_code : bucket[0];

  const failed = failures.length > 0;
  const quality = qualityScore(metrics);
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
    call_summary: output.call_summary,
    went_well: wentWell,
    improvements,
    sentiment: output.sentiment,
    conclusion: output.conclusion,
    auditor_confidence: confidence,
    needs_review: confidence < deps.reviewThreshold,
    rubric_version: rubric.version,
    agent_label: agentLabel,
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

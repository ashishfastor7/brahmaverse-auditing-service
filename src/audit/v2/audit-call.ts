import type { Judge, JudgeCall, JudgeResponse } from "@/audit/audit-call";
import { locateQuote } from "@/audit/evidence";
import { auditorConfidence } from "@/audit/score";
import type { AgentPrompt, AuditInput } from "@/audit/types";
import type { CallerFlow } from "@/services/v2/caller-flow";
import type { CallRecord } from "./call-record";
import { type BusinessOutcome, type GoalConfig, type Metric, type ScorecardVersion, unavailableMetrics } from "./config";
import { goalRequired, measure, requiredOutputs, STALLING_FILLER_KEY, type MeasuredFacts } from "./facts";
import { AVAILABLE_DATA, buildJudgeMessagesV2, JUDGE_PROMPT_VERSION, judgePlan, retryMessages, type ConditionDefinition, type JudgePlan } from "./judge/prompt";
import { dropMissingTurns, judgeJsonSchemaV2, type JudgeOutputV2, validateJudgeOutput } from "./judge/schema";
import { computeScore, type FailedBy, type MetricResult } from "./score";
import type { Flag, FlagOutcome } from "./severity";
import type { Check, SignalEvidence, SignalResult } from "./signal";
import { systemGoal, type SystemCheckCode } from "./system-checks";

export type CheckResult = "PASS" | "FAIL" | "NOT_APPLICABLE";
/** Evidence as stored (PRD §7): turns, timing (null until a timing source exists, P0-5) and the judge's quote, if any. */
export type StoredEvidence = SignalEvidence & { quote?: string };

export type CheckOutcome = {
  result: CheckResult;
  reason: string;
  evidence: StoredEvidence[];
  /** The deterministic part (S1, S2, S4) and the judge's part (S2, S3, S4); null when that part doesn't exist. */
  rule: { result: CheckResult; reason: string } | null;
  judge: { result: CheckResult; reason: string } | null;
  /** Critical and Major flags that roll up to this check (PRD §4.5); any one fails it. */
  flags: string[];
};

export type MetricOutcome = MetricResult & {
  name: string;
  /** judge: scored by the LLM; rule: scored by code from a signal; unavailable: needs data that doesn't exist yet. */
  source: "judge" | "rule" | "unavailable";
  reason: string;
  evidence: StoredEvidence[];
  /** The Major flag that set this metric to 0 in the score (the raw score above is kept, for re-scoring). */
  zeroed_by: string | null;
};

export type FlagRecord = { code: string; source: "rule" | "judge"; severity: "critical" | "major" | "minor"; reason: string; evidence: StoredEvidence[] };

export type BusinessGoalOutcome = {
  outcome: BusinessOutcome;
  reason_code: string;
  reason: string;
  evidence: StoredEvidence[];
  required_outputs: { key: string; value: string | null; turns: number[] }[];
};

export type AuditResultV2 = {
  engine: "v2";
  /** Computed by `computeScore`, never by the LLM. Null when nothing could be scored. */
  score: number | null;
  /** Null when the judge gave no usable answer and no rule failed the call: there is nothing to decide on. */
  passed: boolean | null;
  failed_by: FailedBy[];
  system_goal: { result: CheckResult; failed: SystemCheckCode[] };
  checks: Record<SystemCheckCode, CheckOutcome>;
  business_goal: BusinessGoalOutcome | null;
  metrics: MetricOutcome[];
  /** Flags that counted, with their severity; `flag_outcome.dropped` lists the ones that didn't. */
  flags: FlagRecord[];
  flag_outcome: FlagOutcome | null;
  weights_used: Record<string, number>;
  call_summary: string | null;
  transcript_quality: "good" | "fair" | "poor" | null;
  auditor_confidence: number;
  needs_review: boolean;
  review_reasons: string[];
  facts: MeasuredFacts;
  scorecard: { scorecard_id: string; version: number };
  goal_version: number;
  agent_label: string | null;
  judge: {
    model: string;
    prompt_version: string;
    instructions: { prompt_code: string; version: number } | null;
    flow_source: CallerFlow["source"];
    self_confidence: number | null;
    evidence_validity: number | null;
    /** Every judge answer exactly as returned, and why it was rejected (empty when it wasn't). */
    attempts: { output: unknown; errors: string[] }[];
  };
};

export type AuditDepsV2 = {
  judge: Judge;
  scorecard: ScorecardVersion;
  goal: GoalConfig;
  weights: Record<string, number>;
  definitions: ConditionDefinition[];
  instructions: AgentPrompt | null;
  flow: CallerFlow;
  agentLabel: string | null;
  reviewThreshold: number;
};

export type PreparedJudge = { facts: MeasuredFacts; plan: JudgePlan; call: JudgeCall };

/** Pipeline steps 2–3: measure, then build the judge request. Pure; the replay script prints it for review. */
export function prepareJudgeV2(input: AuditInput, record: CallRecord, deps: Omit<AuditDepsV2, "judge" | "reviewThreshold">): PreparedJudge {
  const required = goalRequired(deps.goal);
  const facts = measure(record, deps.scorecard.metrics, required);
  const plan = judgePlan({
    scorecard: deps.scorecard,
    weights: deps.weights,
    goal: deps.goal,
    definitions: deps.definitions,
    requiredOutputs: requiredOutputs(record, required),
  });
  const messages = buildJudgeMessagesV2({
    input,
    agentLabel: deps.agentLabel,
    scorecard: deps.scorecard,
    goal: deps.goal,
    plan,
    instructions: deps.instructions,
    flow: deps.flow,
    facts,
  });
  return { facts, plan, call: { messages, schema: judgeJsonSchemaV2(plan), schemaName: "call_audit_v2" } };
}

const RESULT: Record<SignalResult, CheckResult> = { pass: "PASS", fail: "FAIL", na: "NOT_APPLICABLE" };
const SIGNAL: Record<CheckResult, SignalResult> = { PASS: "pass", FAIL: "fail", NOT_APPLICABLE: "na" };
const toEvidence = (e: { turns: number[]; quote: string }): StoredEvidence => ({ turns: e.turns, ts_start: null, ts_end: null, quote: e.quote });

/** A check from its rule part and judge part: FAIL if either fails, N/A only if every part is N/A. */
function combine(rule: Check<unknown> | null, judge: JudgeOutputV2["system_checks"][number] | null): CheckOutcome {
  const parts = [
    rule && { result: RESULT[rule.result], reason: rule.reason, evidence: rule.evidence as StoredEvidence[] },
    judge && { result: judge.result, reason: judge.reason, evidence: judge.evidence.map(toEvidence) },
  ].filter((p) => p !== null);
  const failed = parts.filter((p) => p.result === "FAIL");
  const result: CheckResult = failed.length ? "FAIL" : parts.length && parts.every((p) => p.result === "NOT_APPLICABLE") ? "NOT_APPLICABLE" : parts.length ? "PASS" : "NOT_APPLICABLE";
  const shown = failed.length ? failed : parts.slice(-1);
  return {
    result,
    reason: shown.map((p) => p.reason).join(" ") || "Not judged.",
    evidence: shown.flatMap((p) => p.evidence),
    rule: rule ? { result: RESULT[rule.result], reason: rule.reason } : null,
    judge: judge ? { result: judge.result, reason: judge.reason } : null,
    flags: [],
  };
}

/** Rule metrics scored by code from their signal, on the metric's anchors (full = scale, partial = half, zero = 0). */
function ruleMetric(metric: Pick<Metric, "key" | "scale">, facts: MeasuredFacts): Pick<MetricOutcome, "score" | "n_a" | "reason" | "evidence"> {
  const signal = metric.key === STALLING_FILLER_KEY ? facts.stalling_filler : null;
  if (!signal) return { score: null, n_a: true, reason: "No rule scores this metric yet.", evidence: [] };
  if (signal.result === "na") return { score: null, n_a: true, reason: `Too few agent words (${signal.value.agent_words}).`, evidence: [] };
  const score = signal.value.band === "full" ? metric.scale : signal.value.band === "partial" ? metric.scale / 2 : 0;
  return { score, n_a: false, reason: `${signal.value.rate} stalling phrases and filler words per 100 agent words (${signal.value.band}).`, evidence: signal.evidence };
}

/** Share of judge quotes found in the transcript (PRD §2 goal 5: an auditor that invents evidence is worse than none). */
function quoteValidity(output: JudgeOutputV2, transcript: AuditInput["transcript"]): number {
  const items = [
    ...output.system_checks.flatMap((c) => c.evidence),
    ...output.business_goal.evidence,
    ...output.metrics.flatMap((m) => m.evidence),
    ...output.failure_conditions.flatMap((f) => f.evidence),
  ].filter((e) => e.turns.length > 0);
  if (items.length === 0) return 1;
  return items.filter((e) => locateQuote(transcript, e.turns[0]!, e.quote).valid).length / items.length;
}

/**
 * P1-7, PRD §7 steps 2–7: signals → judge (one retry on an unusable answer) → severities → `computeScore` → system
 * and business goals. Pure apart from the injected judge, so tests run it on recorded responses.
 *
 * When the second answer is still unusable, the audit is kept for a human: an answer that parses is used with the
 * evidence for missing turns removed; one that doesn't leaves only the rule parts (no score, no business goal). Either
 * way `needs_review` is set. A judge that throws (network, refusal) propagates.
 */
export async function auditCallV2(input: AuditInput, record: CallRecord, deps: AuditDepsV2): Promise<{ result: AuditResultV2; usage: JudgeResponse["usage"] }> {
  const { facts, plan, call } = prepareJudgeV2(input, record, deps);
  const usage = { input_tokens: 0, output_tokens: 0 };
  const attempts: AuditResultV2["judge"]["attempts"] = [];
  const ask = async (c: JudgeCall) => {
    const response = await deps.judge(c);
    usage.input_tokens += response.usage.input_tokens;
    usage.output_tokens += response.usage.output_tokens;
    const validation = validateJudgeOutput(response.output, plan, input.transcript);
    attempts.push({ output: response.output, errors: validation.errors });
    return { response, validation };
  };

  const first = await ask(call);
  let last = first;
  let output = first.validation.errors.length === 0 ? first.validation.output : null;
  const reviewReasons: string[] = [];
  if (!output) {
    last = await ask({ ...call, messages: retryMessages(call.messages, first.response.output, first.validation.errors) });
    output = last.validation.errors.length === 0 ? last.validation.output : null;
    if (!output) {
      const usable = last.validation.output ?? first.validation.output;
      output = usable ? dropMissingTurns(usable, input.transcript) : null;
      reviewReasons.push(`judge answer still unusable after one retry: ${last.validation.errors.join("; ")}`);
    }
  }

  const judgeCheck = (code: string) => output?.system_checks.find((c) => c.check === code) ?? null;
  const checks: Record<SystemCheckCode, CheckOutcome> = {
    S1: combine(facts.connected, null),
    S2: combine(facts.conversation, judgeCheck("S2")),
    S3: combine(null, judgeCheck("S3")),
    S4: combine(facts.data_saved, judgeCheck("S4")),
  };

  const unavailable = new Set(unavailableMetrics(deps.scorecard.metrics, AVAILABLE_DATA));
  const judged = new Set(plan.metrics.map((m) => m.key));
  const metrics: MetricOutcome[] = [];
  for (const m of deps.scorecard.metrics) {
    if ((deps.weights[m.key] ?? 0) <= 0) continue; // PRD §4.4: weight 0 excludes the metric from this audit
    const base = { key: m.key, name: m.name, max: m.scale, zeroed_by: null };
    if (unavailable.has(m.key)) {
      metrics.push({ ...base, score: null, n_a: true, source: "unavailable", reason: `Needs ${m.requires.join(", ")}, not available yet.`, evidence: [] });
    } else if (judged.has(m.key)) {
      const j = output?.metrics.find((x) => x.key === m.key);
      if (j) metrics.push({ ...base, score: j.n_a ? null : j.score, n_a: j.n_a, source: "judge", reason: j.reason, evidence: j.evidence.map(toEvidence) });
    } else {
      metrics.push({ ...base, source: "rule", ...ruleMetric(m, facts) });
    }
  }

  const ruleFlags: Flag[] = [];
  if (facts.conversation.value.ended_by.result === "fail") ruleFlags.push({ code: "CALL_ERROR", source: "rule", evidence: facts.conversation.value.ended_by.evidence });
  if (facts.connected.result === "fail" && facts.connected.value.agent_turns === 0) ruleFlags.push({ code: "NO_AGENT_SPEECH", source: "rule", evidence: [] });
  const judgeFlags: Flag[] = (output?.failure_conditions ?? []).map((f) => ({ code: f.code, source: "judge", evidence: f.evidence.map(toEvidence) }));
  const reasons = new Map<string, string>([
    ...ruleFlags.map((f) => [f.code, f.code === "CALL_ERROR" ? facts.conversation.value.ended_by.reason : facts.connected.reason] as [string, string]),
    ...(output?.failure_conditions ?? []).map((f) => [f.code, f.reason] as [string, string]),
  ]);

  let score: number | null = null;
  let passed: boolean | null = null;
  let failedBy: FailedBy[] = [];
  let flagOutcome: FlagOutcome | null = null;
  const flags = [...ruleFlags, ...judgeFlags];
  const scored = computeScore(metrics, deps.weights, deps.scorecard, flags);
  flagOutcome = scored.flags;
  if (output) {
    ({ score, passed, failedBy } = scored);
  } else if (scored.flags.critical.length) {
    // No usable judge answer: only a Critical rule flag can decide the call.
    passed = false;
    failedBy = scored.failedBy.filter((f) => f.kind === "critical");
  }
  for (const m of scored.flags.major) {
    const metric = metrics.find((x) => x.key === m.metric && !x.n_a);
    if (metric) metric.zeroed_by = m.code;
  }
  const severityOf = (code: string) =>
    scored.flags.critical.includes(code) ? "critical" : scored.flags.major.some((m) => m.code === code) ? "major" : scored.flags.minor.includes(code) ? "minor" : null;
  const flagRecords: FlagRecord[] = [];
  for (const f of flags) {
    const severity = severityOf(f.code);
    if (!severity || flagRecords.some((r) => r.code === f.code)) continue;
    if (f.source === "judge" && ruleFlags.some((r) => r.code === f.code)) continue; // a rule hit wins
    flagRecords.push({ code: f.code, source: f.source, severity, reason: reasons.get(f.code) ?? "", evidence: f.evidence as StoredEvidence[] });
  }

  // Open #21 (decided 2026-10-28): a Critical or Major flag fails the system check it rolls up to (PRD §4.5), e.g.
  // IGNORED_STOP_REQUEST → S2. Minor flags are counted only.
  for (const f of flagRecords.filter((r) => r.severity !== "minor")) {
    const rollsUpTo = deps.definitions.find((d) => d.code === f.code)?.rolls_up_to ?? [];
    const codes = new Set(rollsUpTo.map((r) => /^S[1-4]\b/.exec(r)?.[0] as SystemCheckCode | undefined).filter((c) => c !== undefined));
    for (const code of codes) {
      const c = checks[code];
      c.flags.push(f.code);
      if (c.result === "FAIL") continue;
      c.result = "FAIL";
      c.reason = `${f.code} was flagged (${f.severity}): ${f.reason}`;
      c.evidence = f.evidence;
    }
  }
  const goal = systemGoal(Object.fromEntries(Object.entries(checks).map(([k, c]) => [k, { result: SIGNAL[c.result] }])) as Record<SystemCheckCode, { result: SignalResult }>);

  const evidenceValidity = output ? quoteValidity(output, input.transcript) : null;
  const confidence = output
    ? auditorConfidence({
        selfConfidence: output.confidence,
        evidenceValidity: evidenceValidity!,
        transcriptQuality: output.transcript_quality.rating,
        hadAgentPrompt: deps.instructions !== null,
      })
    : 0;
  if (confidence < deps.reviewThreshold) reviewReasons.push(`auditor confidence ${confidence} is below ${deps.reviewThreshold}`);

  const result: AuditResultV2 = {
    engine: "v2",
    score,
    passed,
    failed_by: failedBy,
    system_goal: { result: RESULT[goal.result], failed: goal.failed },
    checks,
    business_goal: output
      ? {
          outcome: output.business_goal.outcome,
          reason_code: output.business_goal.reason_code,
          reason: output.business_goal.reason,
          evidence: output.business_goal.evidence.map(toEvidence),
          required_outputs: output.business_goal.required_outputs,
        }
      : null,
    metrics,
    flags: flagRecords,
    flag_outcome: flagOutcome,
    weights_used: deps.weights,
    call_summary: output?.call_summary ?? null,
    transcript_quality: output?.transcript_quality.rating ?? null,
    auditor_confidence: confidence,
    needs_review: reviewReasons.length > 0,
    review_reasons: reviewReasons,
    facts,
    scorecard: { scorecard_id: deps.scorecard.scorecard_id, version: deps.scorecard.version },
    goal_version: deps.goal.version,
    agent_label: deps.agentLabel,
    judge: {
      model: last.response.model,
      prompt_version: JUDGE_PROMPT_VERSION,
      instructions: deps.instructions ? { prompt_code: deps.instructions.prompt_code, version: deps.instructions.version } : null,
      flow_source: deps.flow.source,
      self_confidence: output?.confidence ?? null,
      evidence_validity: evidenceValidity === null ? null : Math.round(evidenceValidity * 100) / 100,
      attempts,
    },
  };
  return { result, usage };
}

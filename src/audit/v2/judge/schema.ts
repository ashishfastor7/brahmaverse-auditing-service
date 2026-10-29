import type { Turn } from "@/audit/types";
import { z } from "zod";
import { JUDGED_CHECKS, type JudgePlan } from "./prompt";

const TRANSCRIPT_QUALITY = ["good", "fair", "poor"] as const;
const CHECK_RESULTS = ["PASS", "FAIL", "NOT_APPLICABLE"] as const;

// Strict structured output: every property required, no extra ones, at every level. Models generate in schema order,
// so reasons and evidence come before the verdict they justify (as in v1's schema).
const obj = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const str = (description?: string) => ({ type: "string", ...(description ? { description } : {}) });
/** Strict mode rejects an empty enum: with nothing to choose from, a plain string that the validator then rejects. */
const oneOf = (values: readonly (string | number)[], type: "string" | "integer" = "string") => (values.length ? { type, enum: values } : { type });
const turns = { type: "array", items: { type: "integer" }, description: "Transcript turn numbers" };
const evidenceList = {
  type: "array",
  items: obj({ turns, quote: str("Exact words copied from the first of those turns") }),
};

/** JSON schema for one v2 judge run; enums come from the plan, so codes and keys can't drift. */
export function judgeJsonSchemaV2(plan: JudgePlan) {
  const reasonCodes = [...new Set(Object.values(plan.reasonCodes).flat())];
  const maxScale = Math.max(0, ...plan.metrics.map((m) => m.scale));
  return obj({
    call_summary: str("Two to four sentences: who called whom, why, what happened, and how it ended"),
    transcript_quality: obj({ rating: oneOf(TRANSCRIPT_QUALITY), note: str("What, if anything, about the transcript makes judging harder") }),
    system_checks: {
      type: "array",
      description: `Exactly one entry for each of ${JUDGED_CHECKS.join(", ")}, in that order.`,
      items: obj({ check: oneOf(JUDGED_CHECKS), reason: str(), evidence: evidenceList, result: oneOf(CHECK_RESULTS) }),
    },
    business_goal: obj({
      reason: str(),
      evidence: evidenceList,
      outcome: oneOf(plan.outcomes),
      reason_code: oneOf(reasonCodes),
      required_outputs: {
        type: "array",
        description: "One entry per required output, in the order listed; empty when none are listed.",
        items: obj({ key: oneOf(plan.requiredOutputs), value: { type: ["string", "null"] }, turns }),
      },
    }),
    metrics: {
      type: "array",
      description: "Exactly one entry per metric listed, in order.",
      items: obj({
        key: oneOf(plan.metrics.map((m) => m.key)),
        reason: str(),
        evidence: evidenceList,
        n_a: { type: "boolean", description: "true only when the metric's 'N/A when' condition holds" },
        score: { ...oneOf(Array.from({ length: maxScale + 1 }, (_, i) => i), "integer"), description: "0 to the metric's scale; 0 when n_a" },
      }),
    },
    failure_conditions: {
      type: "array",
      description: "Only conditions that clearly happened. Empty if none.",
      items: obj({ code: oneOf(plan.conditions.map((c) => c.code)), reason: str(), evidence: { ...evidenceList, description: "Every turn involved" } }),
    },
    confidence: { type: "number", description: "0 to 1: how sure you are of this assessment" },
  });
}

const evidence = z.array(z.object({ turns: z.array(z.number().int()), quote: z.string() }));

/** Runtime check of the judge's response: strict mode is trusted, but not blindly. */
export const judgeOutputSchemaV2 = z.object({
  call_summary: z.string(),
  transcript_quality: z.object({ rating: z.enum(TRANSCRIPT_QUALITY), note: z.string() }),
  system_checks: z.array(z.object({ check: z.enum(JUDGED_CHECKS), reason: z.string(), evidence, result: z.enum(CHECK_RESULTS) })),
  business_goal: z.object({
    reason: z.string(),
    evidence,
    outcome: z.enum(["ACHIEVED", "PARTIAL", "NOT_ACHIEVED", "NOT_APPLICABLE"]),
    reason_code: z.string(),
    required_outputs: z.array(z.object({ key: z.string(), value: z.string().nullable(), turns: z.array(z.number().int()) })),
  }),
  metrics: z.array(z.object({ key: z.string(), reason: z.string(), evidence, n_a: z.boolean(), score: z.number().int().min(0) })),
  failure_conditions: z.array(z.object({ code: z.string(), reason: z.string(), evidence })),
  confidence: z.number().min(0).max(1),
});

export type JudgeOutputV2 = z.infer<typeof judgeOutputSchemaV2>;
export type Validation = { output: JudgeOutputV2 | null; errors: string[] };

const dupes = (keys: string[]) => [...new Set(keys.filter((k, i) => keys.indexOf(k) !== i))];

/**
 * PRD §7: whether a judge response can be used. `output` is null when it isn't JSON of the right shape (nothing in it
 * can be used); otherwise `errors` lists what makes it unusable as is:
 * - a check or metric missing, duplicated or not asked for, a score over the metric's scale, an outcome or a reason
 *   code that wasn't offered, a required output that wasn't asked for;
 * - evidence citing a turn that isn't in the transcript;
 * - a deduction without evidence: a metric below its maximum that isn't N/A, or a check marked FAIL.
 * A failure condition without evidence is not an error here: `applySeverity` drops it (PRD §4.5).
 */
export function validateJudgeOutput(raw: unknown, plan: JudgePlan, transcript: Pick<Turn, "turn">[]): Validation {
  if (typeof raw === "string") return { output: null, errors: ["the response is not valid JSON"] };
  const parsed = judgeOutputSchemaV2.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    return { output: null, errors: [`the response does not match the schema (${issues.join("; ")})`] };
  }
  const output = parsed.data;
  const errors: string[] = [];

  const checks = output.system_checks.map((c) => c.check);
  const missingChecks = JUDGED_CHECKS.filter((c) => !checks.includes(c));
  if (missingChecks.length) errors.push(`system_checks is missing ${missingChecks.join(", ")}`);
  if (dupes(checks).length) errors.push(`system_checks has ${dupes(checks).join(", ")} more than once`);

  const asked = new Map(plan.metrics.map((m) => [m.key, m]));
  const keys = output.metrics.map((m) => m.key);
  const missing = plan.metrics.filter((m) => !keys.includes(m.key)).map((m) => m.key);
  if (missing.length) errors.push(`metrics is missing ${missing.join(", ")}`);
  if (dupes(keys).length) errors.push(`metrics has ${dupes(keys).join(", ")} more than once`);
  const extra = keys.filter((k) => !asked.has(k));
  if (extra.length) errors.push(`metrics has ${extra.join(", ")}, which was not asked for`);
  for (const m of output.metrics) {
    const metric = asked.get(m.key);
    if (metric && m.score > metric.scale) errors.push(`metric ${m.key} scored ${m.score}, over its scale of ${metric.scale}`);
    if (metric && !m.n_a && m.score < metric.scale && m.evidence.length === 0) errors.push(`metric ${m.key} lost points without evidence`);
  }
  for (const c of output.system_checks) if (c.result === "FAIL" && c.evidence.length === 0) errors.push(`check ${c.check} is FAIL without evidence`);

  const goal = output.business_goal;
  if (!plan.outcomes.includes(goal.outcome)) errors.push(`business_goal outcome ${goal.outcome} was not offered`);
  else if (!plan.reasonCodes[goal.outcome]!.includes(goal.reason_code))
    errors.push(`reason code ${goal.reason_code} is not one of ${goal.outcome}'s (${plan.reasonCodes[goal.outcome]!.join(", ")})`);
  const outputKeys = goal.required_outputs.map((o) => o.key);
  const unknownOutputs = outputKeys.filter((k) => !plan.requiredOutputs.includes(k));
  if (unknownOutputs.length) errors.push(`required_outputs has ${unknownOutputs.join(", ")}, which was not asked for`);
  const knownCodes = new Set(plan.conditions.map((c) => c.code));
  const unknownCodes = output.failure_conditions.map((f) => f.code).filter((c) => !knownCodes.has(c));
  if (unknownCodes.length) errors.push(`failure_conditions has ${unknownCodes.join(", ")}, which was not asked for`);

  const exists = new Set(transcript.map((t) => t.turn));
  const cited = [
    ...output.system_checks.flatMap((c) => c.evidence.flatMap((e) => e.turns)),
    ...goal.evidence.flatMap((e) => e.turns),
    ...goal.required_outputs.flatMap((o) => o.turns),
    ...output.metrics.flatMap((m) => m.evidence.flatMap((e) => e.turns)),
    ...output.failure_conditions.flatMap((f) => f.evidence.flatMap((e) => e.turns)),
  ];
  const bad = [...new Set(cited.filter((t) => !exists.has(t)))].sort((a, b) => a - b);
  if (bad.length) errors.push(`evidence cites turn${bad.length === 1 ? "" : "s"} ${bad.join(", ")}, which the transcript (turns 1–${transcript.length}) does not have`);
  return { output, errors };
}

/** Removes evidence items (and required-output turns) that cite turns not in the transcript. For a last-resort answer. */
export function dropMissingTurns(output: JudgeOutputV2, transcript: Pick<Turn, "turn">[]): JudgeOutputV2 {
  const exists = new Set(transcript.map((t) => t.turn));
  const keep = (list: JudgeOutputV2["metrics"][number]["evidence"]) => list.filter((e) => e.turns.length > 0 && e.turns.every((t) => exists.has(t)));
  return {
    ...output,
    system_checks: output.system_checks.map((c) => ({ ...c, evidence: keep(c.evidence) })),
    business_goal: {
      ...output.business_goal,
      evidence: keep(output.business_goal.evidence),
      required_outputs: output.business_goal.required_outputs.map((o) => ({ ...o, turns: o.turns.filter((t) => exists.has(t)) })),
    },
    metrics: output.metrics.map((m) => ({ ...m, evidence: keep(m.evidence) })),
    failure_conditions: output.failure_conditions.map((f) => ({ ...f, evidence: keep(f.evidence) })),
  };
}

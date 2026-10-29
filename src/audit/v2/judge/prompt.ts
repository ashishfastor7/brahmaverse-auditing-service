import type { JudgeMessage } from "@/audit/audit-call";
import { MAX_AGENT_PROMPT_CHARS } from "@/audit/judge/prompt";
import type { AgentPrompt, AuditInput } from "@/audit/types";
import type { CallerFlow } from "@/services/v2/caller-flow";
import { type BusinessOutcome, type GoalConfig, type Metric, type Requirement, type ScorecardVersion, unavailableMetrics } from "../config";
import type { LibraryCondition } from "../conditions";
import type { MeasuredFacts } from "../facts";
import type { Check, SignalResult } from "../signal";

/**
 * The v2 judge prompt (PRD §3, §4, §7; P1-4). Bump `JUDGE_PROMPT_VERSION` whenever any wording here changes: it is
 * stored on every audit, so scores from different prompts are never mixed. Wording changes need approval first.
 */
export const JUDGE_PROMPT_VERSION = "v2-1";

/** Data that exists for every call today. Metrics needing anything else are N/A (PRD §4.3) until Phase 3. */
export const AVAILABLE_DATA: Requirement[] = [];

/** The checks the judge answers; S1 is rule-only. */
export const JUDGED_CHECKS = ["S2", "S3", "S4"] as const;
export type JudgedCheck = (typeof JUDGED_CHECKS)[number];

/** A library condition as the v2 audit uses it; `rolls_up_to` names the system checks (S1–S4) and metrics it rolls up to. */
export type ConditionDefinition = Pick<LibraryCondition, "code" | "label" | "definition" | "detection"> & { rolls_up_to: string[] };
export type JudgedMetric = Pick<Metric, "key" | "name" | "rubric" | "applicability" | "scale" | "method">;

/** What one judge run is asked: the schema and the validator are built from the same plan, so their enums agree. */
export type JudgePlan = {
  metrics: JudgedMetric[];
  conditions: ConditionDefinition[];
  outcomes: BusinessOutcome[];
  /** Reason codes per offered outcome; an outcome without any gets `NONE`. */
  reasonCodes: Record<string, string[]>;
  requiredOutputs: string[];
};

export const NO_REASON_CODE = "NONE";

/**
 * The metrics the judge scores in this run: LLM or hybrid, weighted above 0, and not waiting on data that doesn't exist
 * (PRD §4.4: a weight-0 metric is skipped by the judge). Rule metrics are scored by code.
 */
export function judgedMetrics<M extends Pick<Metric, "key" | "method" | "requires">>(metrics: M[], weights: Record<string, number>): M[] {
  const unavailable = new Set(unavailableMetrics(metrics, AVAILABLE_DATA));
  return metrics.filter((m) => (m.method === "llm" || m.method === "hybrid") && (weights[m.key] ?? 0) > 0 && !unavailable.has(m.key));
}

export function judgePlan(opts: {
  scorecard: Pick<ScorecardVersion, "metrics" | "conditions">;
  weights: Record<string, number>;
  goal: Pick<GoalConfig, "partial_success" | "reason_codes">;
  definitions: ConditionDefinition[];
  requiredOutputs: string[];
}): JudgePlan {
  const enabled = new Set(opts.scorecard.conditions.filter((c) => c.enabled).map((c) => c.condition_code));
  const outcomes: BusinessOutcome[] = ["ACHIEVED", ...(opts.goal.partial_success.length ? ["PARTIAL" as const] : []), "NOT_ACHIEVED", "NOT_APPLICABLE"];
  const reasonCodes = Object.fromEntries(
    outcomes.map((o) => {
      const codes = opts.goal.reason_codes[o] ?? [];
      return [o, codes.length ? codes : [NO_REASON_CODE]];
    }),
  );
  return {
    metrics: judgedMetrics(opts.scorecard.metrics, opts.weights),
    conditions: opts.definitions.filter((d) => d.detection === "llm" && enabled.has(d.code)).sort((a, b) => a.code.localeCompare(b.code)),
    outcomes,
    reasonCodes,
    requiredOutputs: opts.requiredOutputs,
  };
}

const SYSTEM_RULES = `You are a strict, fair quality auditor for phone calls handled by an AI voice agent. You grade one finished call against the definitions below and return the result in the required JSON structure. You do not compute the overall score or pass/fail: code does that from your answers.

How to judge:
- System checks, metrics and failure conditions judge only the AGENT's behaviour. The other party's choices (declining, being busy, hanging up) are not the agent's fault: they decide the business goal, not the rest.
- The transcript comes from speech recognition on a phone line. The other party's lines are often mis-transcribed into nonsense or a wrong language, and Hindi/English may be mixed. Do not penalise the agent for transcription noise. When the agent restates a value and the other party confirms, treat the restated value as what was said.
- "Measured facts" were computed by code from the call record and transcript. Treat them as true. You may explain them (for example, whether a repeated line was a legitimate re-ask), but never contradict them.
- Evidence: each item lists the turn numbers it rests on and a short quote copied exactly from the first of those turns (the key words, never paraphrased). Never cite a turn that does not exist. Every metric scored below its maximum, every check you mark FAIL and every failure condition you flag needs evidence; for a loop, cite every repetition.
- Metrics: write the reason and cite evidence first, then score on the metric's scale against its anchors. Apply the anchors literally and count occurrences. When torn between two levels, choose the lower. Set n_a only when the metric's "N/A when" condition holds; if the agent itself skipped something it should have done, the metric applies and scores low.
- System checks: judge S2, S3 and S4 as defined below. Use NOT_APPLICABLE only when the stated condition holds.
- Business goal: ACHIEVED only when the success criteria are met; PARTIAL only when the partial-success criteria are met; NOT_APPLICABLE when any not-applicable condition holds; otherwise NOT_ACHIEVED. Pick the reason code from the list for that outcome. For each required output, give the value as said and confirmed in the call, or null if it never came up.
- Failure conditions: flag one only when it clearly happened as defined, and never in a case its definition excludes. If the instructions, flow or outcome a condition depends on are not provided, do not flag it.
- confidence (0 to 1): lower it when the transcript is garbled or very short, or when instructions or flow are missing.`;

const CHECK_DEFINITIONS: Record<JudgedCheck, string> = {
  S2:
    "S2 Conversation handled: the agent responded to every caller turn through the call; no loop and no agent-side drop. " +
    "Re-asking after a missing or unclear reply is not a loop. If the measured S2 parts FAIL, S2 is FAIL: say why and cite the turns.",
  S3:
    "S3 Flow completed where possible: every required flow step was reached, or the call ended early for a legitimate reason " +
    "(caller hung up, not interested, wrong person). NOT_APPLICABLE when no flow or steps are provided.",
  S4:
    "S4 Data saved: the saved outcome's values are consistent with what was said. NOT_APPLICABLE when nothing was saved. " +
    "Whether the required fields are present is measured (see Measured facts).",
};

/** How a hybrid metric uses its measured signal. */
const HYBRID_NOTES: Record<string, string> = {
  repetition:
    "Measured: the repeated agent lines under Measured facts. Decide whether each repeat was needed; a re-ask after a missing or " +
    "unclear reply, or a repeat the caller asked for, is not a deduction.",
  language_match:
    "Measured: the language of each turn under Measured facts. Decide whether each mismatch was the agent's fault; single " +
    "borrowed words are not.",
};

const bullets = (items: string[]) => items.map((s) => `- ${s}`).join("\n");

function definitionsText(plan: JudgePlan, goal: Pick<GoalConfig, "name" | "description" | "version" | "success_criteria" | "partial_success" | "not_applicable_when">, scorecard: { scorecard_id: string; version: number }, agentLabel: string | null): string {
  const lines: string[] = [];
  if (agentLabel) lines.push(`# Agent\n${agentLabel}.`);

  lines.push(`# Business goal: ${goal.name} (goal config v${goal.version})\n${goal.description}`);
  lines.push(`ACHIEVED when:\n${bullets(goal.success_criteria)}`);
  if (plan.outcomes.includes("PARTIAL")) lines.push(`PARTIAL when:\n${bullets(goal.partial_success)}`);
  lines.push(`NOT_APPLICABLE when any of (these are not the agent's fault):\n${bullets(goal.not_applicable_when)}`);
  lines.push("Otherwise NOT_ACHIEVED.");
  lines.push(`Reason codes, by outcome:\n${bullets(plan.outcomes.map((o) => `${o}: ${plan.reasonCodes[o]!.join(", ")}`))}`);
  lines.push(
    plan.requiredOutputs.length
      ? `Required outputs to extract: ${plan.requiredOutputs.join(", ")}`
      : "Required outputs to extract: none for this call (return an empty list).",
  );

  lines.push(`\n# System checks\nS1 Connected is measured by code (see Measured facts). Judge these three:\n${bullets(JUDGED_CHECKS.map((c) => CHECK_DEFINITIONS[c]))}`);

  lines.push(`\n# Metrics (scorecard ${scorecard.scorecard_id} v${scorecard.version}; score each 0 to its scale, values between anchors allowed)`);
  for (const m of plan.metrics) {
    const note = m.method === "hybrid" && HYBRID_NOTES[m.key] ? `\n  ${HYBRID_NOTES[m.key]}` : "";
    lines.push(
      `- ${m.key} (${m.name}), scale 0–${m.scale}: ${m.rubric.checks}\n  N/A when: ${m.applicability}\n` +
        `  0 = ${m.rubric.anchors[0]}\n  ${m.scale / 2} = ${m.rubric.anchors[5]}\n  ${m.scale} = ${m.rubric.anchors[10]}${note}`,
    );
  }

  lines.push(`\n# Failure conditions (flag only those that clearly happened)`);
  lines.push(plan.conditions.length ? plan.conditions.map((c) => `- ${c.code} — ${c.label}: ${c.definition}`).join("\n") : "None for this agent.");
  return lines.join("\n");
}

const RESULT: Record<SignalResult, string> = { pass: "PASS", fail: "FAIL", na: "NOT_APPLICABLE" };
const turnsText = (turns: number[]) => `turn${turns.length === 1 ? "" : "s"} ${turns.join(", ")}`;
const check = (label: string, c: Check<unknown>) => `- ${label}: ${RESULT[c.result]}. ${c.reason}`;

/** The measured facts as short lines; the judge may explain them but not contradict them. Pure. */
export function factsText(facts: MeasuredFacts): string {
  const lines: string[] = [];
  const s1 = facts.connected.value;
  lines.push(`${check("S1 Connected", facts.connected)} (status ${s1.status}, ${s1.agent_turns} agent turns, ${s1.caller_turns} caller turns)`);

  const s2 = facts.conversation.value;
  lines.push(`- S2, measured parts: ${RESULT[facts.conversation.result]}.`);
  lines.push(`  - Ended: ${s2.ended_by.reason}`);
  lines.push(
    s2.loop.value.loops.length
      ? `  - Same agent line repeated without progress: ${s2.loop.value.loops.map((g) => turnsText(g.turns)).join("; ")}.`
      : "  - No agent line repeated without progress.",
  );
  lines.push(`  - Caller questions after the agent's last turn: ${s2.no_response.result === "fail" ? s2.no_response.reason : "none unanswered."}`);

  lines.push(check("S4, required outputs saved", facts.data_saved));

  if (facts.repetition) {
    const groups = facts.repetition.value.groups;
    lines.push(
      groups.length
        ? `- Repetition: agent lines said more than once: ${groups.map((g) => turnsText(g.turns)).join("; ")}.`
        : "- Repetition: no agent line said more than once.",
    );
  }
  if (facts.stalling_filler) {
    const v = facts.stalling_filler.value;
    const counts = (r: Record<string, number>) =>
      Object.entries(r)
        .map(([k, n]) => `"${k}" ×${n}`)
        .join(", ") || "none";
    lines.push(
      `- Stalling & filler words (scored by code): stalling phrases ${counts(v.stalling.by_phrase)}; filler words ${counts(v.filler.by_word)}; ` +
        `${v.rate} per 100 of ${v.agent_words} agent words.`,
    );
  }
  if (facts.language) {
    const v = facts.language.value;
    // Only the turns that differ from the caller's language; the rest would be noise.
    const other = v.turns.filter((t) => t.lang !== "und" && t.lang !== v.caller_language);
    lines.push(
      v.caller_language === null
        ? "- Language: the caller's language could not be identified."
        : `- Language: the caller's language is ${v.caller_language}; agent turns in another language: ${v.mismatches.length ? v.mismatches.join(", ") : "none"}.` +
            (other.length ? ` Turns in another language: ${other.map((t) => `[${t.turn}] ${t.speaker} ${t.lang}`).join(", ")}.` : ""),
    );
  }
  return lines.join("\n");
}

const truncate = (text: string) => (text.length > MAX_AGENT_PROMPT_CHARS ? text.slice(0, MAX_AGENT_PROMPT_CHARS) + "\n[...truncated]" : text);

function flowText(flow: CallerFlow, instructions: AgentPrompt | null): string {
  if (flow.source === "vajra") {
    const steps = flow.steps.map((s) => {
      const head = `${s.step}${s.name ? ` (${s.name})` : ""} [${s.type}]${s.text ? `: ${s.text}` : ""}`;
      const fields = s.fields.length
        ? `\n  Fields: ${s.fields.map((f) => `${f.variable}${f.required ? " (required)" : ""}`).join(", ")}`
        : "";
      const next = s.next.length ? `\n  Next: ${s.next.map((r) => (r.when ? `${r.step} when ${r.when}` : r.step)).join("; ")}` : "";
      return `${head}${fields}${next}`;
    });
    return `# Flow (Caller workflow v${flow.version}; required steps and fields are marked)\n${steps.join("\n")}`;
  }
  if (flow.text === null) return `# Flow\nNot available (${flow.reason}). Judge S3 and flow adherence from the instructions, if any.`;
  if (instructions && flow.text === instructions.system_prompt) return "# Flow\nThe steps are in the agent's instructions above.";
  return `# Flow (the compiled prompt the agent was given)\n${truncate(flow.text)}`;
}

export type JudgeContext = {
  input: Pick<AuditInput, "call_id" | "call_type" | "duration" | "ended_reason" | "variables" | "outcome" | "summary" | "transcript">;
  agentLabel: string | null;
  scorecard: { scorecard_id: string; version: number };
  goal: Pick<GoalConfig, "name" | "description" | "version" | "success_criteria" | "partial_success" | "not_applicable_when">;
  plan: JudgePlan;
  instructions: AgentPrompt | null;
  flow: CallerFlow;
  facts: MeasuredFacts;
};

/** The v2 judge messages for one call. Pure. */
export function buildJudgeMessagesV2(ctx: JudgeContext): JudgeMessage[] {
  const { input } = ctx;
  const system = `${SYSTEM_RULES}\n\n${definitionsText(ctx.plan, ctx.goal, ctx.scorecard, ctx.agentLabel)}`;

  const parts: string[] = [];
  const direction =
    input.call_type === "inbound" ? " (the other party called the agent)" : input.call_type === "outbound" ? " (the agent called the other party)" : "";
  parts.push(
    `# Call\n- Call id: ${input.call_id}\n- Direction: ${input.call_type ?? "unknown"}${direction}\n` +
      `- Duration: ${input.duration ?? "unknown"} s\n- Ended because: ${input.ended_reason ?? "unknown"}`,
  );

  parts.push(
    ctx.instructions
      ? `# Agent's instructions (source of truth for facts and required steps)\n${truncate(ctx.instructions.system_prompt)}`
      : `# Agent's instructions\nNot available for this call. The call variables below (if any) are only part of what the agent ` +
          `was told, so a fact missing from them may still be in its instructions: report CRITICAL_HALLUCINATION only for a ` +
          `statement that contradicts the variables.`,
  );
  parts.push(flowText(ctx.flow, ctx.instructions));

  // Caller's compiled prompt sits in variables.prompt; when it is already shown (rendered into the instructions, or as
  // the flow), don't send it again.
  const variables = { ...input.variables };
  const compiled = variables.prompt;
  if (
    typeof compiled === "string" &&
    ((ctx.flow.source === "prompt" && ctx.flow.text === compiled) || ctx.instructions?.system_prompt.includes(compiled.trim()))
  )
    delete variables.prompt;
  if (Object.keys(variables).length > 0) parts.push(`# Call variables (facts given to the agent for this call)\n${JSON.stringify(variables, null, 2)}`);
  parts.push(
    input.outcome && Object.keys(input.outcome).length > 0
      ? `# Recorded outcome (data the agent saved)\n${JSON.stringify(input.outcome, null, 2)}`
      : `# Recorded outcome\nNone recorded.`,
  );
  if (input.summary) parts.push(`# System-generated summary (context only; grade the transcript)\n${input.summary}`);
  parts.push(`# Measured facts (computed by code; do not contradict)\n${factsText(ctx.facts)}`);
  parts.push(`# Transcript\n${input.transcript.map((t) => `[${t.turn}] ${t.speaker}: ${t.text}`).join("\n")}`);

  return [
    { role: "system", content: system },
    { role: "user", content: parts.join("\n\n") },
  ];
}

/** The second attempt: the first answer plus why it was rejected (PRD §7: one retry). */
export function retryMessages(first: JudgeMessage[], previous: unknown, errors: string[]): JudgeMessage[] {
  return [
    ...first,
    { role: "assistant", content: typeof previous === "string" ? previous : JSON.stringify(previous) },
    {
      role: "user",
      content: `Your previous answer was rejected: ${errors.join("; ")}. Return the full JSON again, fixing only these problems.`,
    },
  ];
}

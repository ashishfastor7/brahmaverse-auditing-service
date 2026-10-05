import type { Rubric } from "../rubrics";
import { JUDGE_SCALE, SCORECARD } from "../rubrics/types";
import type { AgentPrompt, AuditInput } from "../types";

// Long prompts are mostly boilerplate; the facts and rules sit well within this.
const MAX_AGENT_PROMPT_CHARS = 16_000;

function rubricText(rubric: Rubric, agentLabel: string | null): string {
  const goal = rubric.goal;
  const lines: string[] = [];
  lines.push(`## Agent\n${agentLabel ? `${agentLabel}. ` : ""}${rubric.context}`);

  lines.push(`\n## Goal\n${goal.description}`);
  lines.push(`ACHIEVED when:\n${goal.achieved_if.map((s) => `- ${s}`).join("\n")}`);
  lines.push(`NOT_APPLICABLE when any of (these are not the agent's fault):\n${goal.not_applicable_if.map((s) => `- ${s}`).join("\n")}`);
  lines.push(`Otherwise NOT_ACHIEVED.`);
  lines.push(
    `Reason codes — use one matching the result:\n` +
      Object.entries(goal.reason_codes)
        .map(([result, codes]) => `- ${result}: ${codes.join(", ")}`)
        .join("\n"),
  );

  lines.push(`\n## Failure conditions (any one fails the call)`);
  for (const f of rubric.failure_conditions) lines.push(`- ${f.code} — ${f.label}: ${f.definition}`);

  lines.push(`\n## Scorecard (score each category 0–${JUDGE_SCALE}; values between anchors are allowed)`);
  for (const { key, label } of SCORECARD) {
    const c = rubric.categories[key];
    lines.push(
      `- ${key} (${label}): ${c.checks}\n  Not applicable when: ${c.not_applicable_when}\n` +
        `  0 = ${c.anchors[0]}\n  5 = ${c.anchors[5]}\n  10 = ${c.anchors[10]}`,
    );
  }
  return lines.join("\n");
}

const SYSTEM_RULES = `You are a strict, fair quality auditor for phone calls handled by an AI voice agent. You grade one call against the rubric below and return the result in the required JSON structure.

How to judge:
- Judge only the AGENT's behaviour. The other party's choices (declining, being busy, ending the call) are not the agent's fault — they affect the goal result, not the scorecard.
- The transcript comes from speech recognition on a phone line. The other party's lines are often mis-transcribed into nonsense or a wrong language, and Hindi/English may be mixed. Do not penalise the agent for transcription noise. When the agent restates a value and the other party confirms, treat the restated value as what was said — and credit the agent for confirming.
- For every scorecard category, write the reasoning and cite evidence FIRST, then give the score. Apply the anchors literally and count occurrences (two re-asked questions is "two or more", not "one lapse"). When torn between two levels, choose the lower one.
- Mark a category applicable=false only when its "not applicable when" condition holds. If the agent itself skipped or cut short something it should have done, the category IS applicable and scores low.
- Every quote must be copied exactly from the transcript line with that turn number. Never paraphrase inside a quote and never cite a turn that does not exist. Keep quotes short (the key words).
- Only report a failure condition when it clearly happened. Cite EVERY turn involved (for a loop, each repetition), each with an exact quote. If the agent's instructions or the outcome are not provided, do not report failures that depend on them.
- went_well and improvements: the most useful specific points for a reviewer (usually 1–4 each), each tied to a turn. Every improvement needs a concrete suggestion of what to do instead. A good call may need no improvements; return an empty list rather than inventing faults.
- confidence: lower it when the transcript is garbled, very short, or when key context is missing.`;

export function buildJudgeMessages(input: AuditInput, rubric: Rubric, agentPrompt: AgentPrompt | null, agentLabel: string | null = null) {
  const system = `${SYSTEM_RULES}\n\n# Rubric (${rubric.version})\n${rubricText(rubric, agentLabel)}`;

  const parts: string[] = [];
  parts.push(
    `# Call\n- Call id: ${input.call_id}\n- Direction: ${input.call_type ?? "unknown"}` +
      `${input.call_type === "inbound" ? " (the other party called the agent)" : input.call_type === "outbound" ? " (the agent called the other party)" : ""}\n` +
      `- Duration: ${input.duration ?? "unknown"} s\n- Ended because: ${input.ended_reason ?? "unknown"}`,
  );

  if (agentPrompt) {
    const text =
      agentPrompt.system_prompt.length > MAX_AGENT_PROMPT_CHARS
        ? agentPrompt.system_prompt.slice(0, MAX_AGENT_PROMPT_CHARS) + "\n[...truncated]"
        : agentPrompt.system_prompt;
    parts.push(`# Agent's instructions (source of truth for facts and required steps)\n${text}`);
  } else {
    parts.push(
      `# Agent's instructions\nNot available for this call. The call variables below (if any) are only part of what the agent ` +
        `was told, so a fact missing from them may still be in its instructions: report CRITICAL_HALLUCINATION only for a ` +
        `statement that contradicts the variables.`,
    );
  }

  if (Object.keys(input.variables).length > 0) {
    parts.push(`# Call variables (facts given to the agent for this call)\n${JSON.stringify(input.variables, null, 2)}`);
  }
  parts.push(
    input.outcome && Object.keys(input.outcome).length > 0
      ? `# Recorded outcome (data the agent saved)\n${JSON.stringify(input.outcome, null, 2)}`
      : `# Recorded outcome\nNone recorded.`,
  );
  if (input.summary) parts.push(`# System-generated summary (context only; grade the transcript)\n${input.summary}`);

  parts.push(`# Transcript\n${input.transcript.map((t) => `[${t.turn}] ${t.speaker}: ${t.text}`).join("\n")}`);

  return [
    { role: "system" as const, content: system },
    { role: "user" as const, content: parts.join("\n\n") },
  ];
}

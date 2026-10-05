import type { Rubric } from "../rubrics";
import type { AgentPrompt, AuditInput } from "../types";

// Long prompts are mostly boilerplate; the facts and rules sit well within this.
const MAX_AGENT_PROMPT_CHARS = 16_000;

function rubricText(rubric: Rubric): string {
  const goal = rubric.goal;
  const lines: string[] = [];
  lines.push(`## Agent\n${rubric.agent_label}. ${rubric.context}`);

  lines.push(`\n## Goal\n${goal.description}`);
  lines.push(`ACHIEVED when all of:\n${goal.achieved_if.map((s) => `- ${s}`).join("\n")}`);
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

  lines.push(`\n## Quality dimensions (score each 0–4; 1 and 3 sit between the anchors)`);
  for (const d of rubric.dimensions) {
    lines.push(`- ${d.key} (${d.label}): ${d.checks}\n  0 = ${d.anchors[0]}\n  2 = ${d.anchors[2]}\n  4 = ${d.anchors[4]}`);
  }
  return lines.join("\n");
}

const SYSTEM_RULES = `You are a strict, fair quality auditor for phone calls handled by an AI voice agent. You grade one call against the rubric below and return the result in the required JSON structure.

How to judge:
- Judge only the AGENT's behaviour. The other party's choices (declining, being busy) are not the agent's fault — they affect the goal result, not quality.
- The transcript comes from speech recognition on a phone line. The other party's lines are often mis-transcribed into nonsense, and Hindi/English may be mixed. Do not penalise the agent for transcription noise. When the agent restates a value and the other party confirms, treat the restated value as what was said — and credit the agent for confirming.
- For every dimension, write the reasoning and cite evidence FIRST, then give the score. Apply the anchors literally and count occurrences (two re-asked questions is "two or more", not "one lapse"). When torn between two levels, choose the lower one.
- Mark a dimension applicable=false only when the call never reached what it measures because of the other party or circumstances (e.g. the candidate asked for a callback before any screening question, so coverage and confirmation cannot be judged). If the agent itself skipped or cut short what it should have done, the dimension IS applicable and scores low. For a non-applicable dimension give score 0 — it is ignored.
- Every quote must be copied exactly from the transcript line with that turn number. Never paraphrase inside a quote and never cite a turn that does not exist. Keep quotes short (the key words).
- Only report a failure condition when it clearly happened, with the turn where it happened. If the agent's instructions or the outcome are not provided, do not report failures that depend on them.
- went_well and went_wrong: the most useful specific points for a reviewer (usually 1–4 each), each tied to a turn. A good call may have nothing wrong; say so by returning an empty list rather than inventing faults.
- confidence: lower it when the transcript is garbled, very short, or when key context is missing.`;

export function buildJudgeMessages(input: AuditInput, rubric: Rubric, agentPrompt: AgentPrompt | null) {
  const system = `${SYSTEM_RULES}\n\n# Rubric (${rubric.version})\n${rubricText(rubric)}`;

  const parts: string[] = [];
  parts.push(
    `# Call\n- Call id: ${input.call_id}\n- Direction: ${input.call_type ?? "unknown"}\n- Duration: ${input.duration ?? "unknown"} s\n` +
      `- Ended because: ${input.ended_reason ?? "unknown"}`,
  );

  if (agentPrompt) {
    const text =
      agentPrompt.system_prompt.length > MAX_AGENT_PROMPT_CHARS
        ? agentPrompt.system_prompt.slice(0, MAX_AGENT_PROMPT_CHARS) + "\n[...truncated]"
        : agentPrompt.system_prompt;
    parts.push(`# Agent's instructions (source of truth for facts and required steps)\n${text}`);
  } else {
    parts.push(`# Agent's instructions\nNot available for this call.`);
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

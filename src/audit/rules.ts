import type { Rubric } from "./rubrics";
import type { AuditInput, FailureReason } from "./types";

export type SkipReason = "NOT_COMPLETED" | "PLAYGROUND" | "NO_TRANSCRIPT";

/** Calls with nothing to judge are recorded as skipped instead of being sent to the LLM. */
export function skipReason(input: AuditInput, opts: { includePlayground: boolean }): SkipReason | null {
  if (input.status !== "completed") return "NOT_COMPLETED";
  if (input.is_playground && !opts.includePlayground) return "PLAYGROUND";
  if (input.transcript.length === 0) return "NO_TRANSCRIPT";
  return null;
}

/** Same line modulo case, punctuation and spacing. */
export const normalizeLine = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

// Short lines ("okay", "got it") legitimately repeat; only longer ones count towards a loop.
const LOOP_MIN_CHARS = 15;
const LOOP_MIN_REPEATS = 3;

/** Deterministic Pass/Fail checks that need no LLM. */
export function ruleFailures(input: AuditInput, rubric: Rubric): FailureReason[] {
  const failures: FailureReason[] = [];

  if (input.ended_reason && rubric.fail_on_ended_reasons.includes(input.ended_reason)) {
    failures.push({
      code: "CALL_ERROR",
      source: "rule",
      explanation: `The call ended with a technical error (${input.ended_reason}).`,
      evidence: [],
      turn: null,
      quote: null,
    });
  }

  const agentTurns = input.transcript.filter((t) => t.speaker === "agent");
  if (agentTurns.length === 0) {
    failures.push({ code: "NO_AGENT_SPEECH", source: "rule", explanation: "The agent never spoke.", evidence: [], turn: null, quote: null });
  }

  const seen = new Map<string, (typeof agentTurns)[number][]>();
  for (const t of agentTurns) {
    const key = normalizeLine(t.text);
    if (key.length < LOOP_MIN_CHARS) continue;
    seen.set(key, [...(seen.get(key) ?? []), t]);
  }
  for (const repeats of seen.values()) {
    if (repeats.length >= LOOP_MIN_REPEATS) {
      const evidence = repeats.map((t) => ({ turn: t.turn, quote: t.text }));
      failures.push({
        code: "AGENT_LOOP",
        source: "rule",
        explanation: `The agent said the same line ${repeats.length} times (turns ${repeats.map((t) => t.turn).join(", ")}).`,
        evidence,
        turn: evidence[0].turn,
        quote: evidence[0].quote,
      });
      break;
    }
  }

  return failures;
}

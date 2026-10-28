import type { Severity } from "./config";

/**
 * PRD §4.5: the shared failure-condition library, as seeded into `failure_condition` (migrations 0004 and 0010).
 * Each scorecard enables the conditions it needs and sets their severity (`scorecard_condition`).
 *
 * The first nine are copied word for word from v1 (`COMMON_FAILURES` in `rubrics/default.ts`, Hansa's two in
 * `rubrics/hansa.ts`, and the `rules.ts` rule codes); v1 keeps using its own copies. Every definition says what does
 * not count, where it has such a clause. `config.test.ts` checks this file against v1 and against the seeds.
 */
export type LibraryCondition = {
  code: string;
  label: string;
  definition: string;
  defaultSeverity: Severity;
  /** The system checks or metrics the condition rolls up to, as named in PRD §4.5. */
  rollsUpTo: string[];
  detection: "rule" | "llm";
};

export const CONDITION_LIBRARY: LibraryCondition[] = [
  {
    code: "CRITICAL_HALLUCINATION",
    label: "Stated false facts",
    definition:
      "The agent stated a material fact (price, policy, date, service, product or job detail) that its instructions contradict or " +
      "do not support. When the full instructions are NOT provided, only flag a statement that contradicts the call variables — " +
      "a fact that is merely absent from the variables is not a hallucination. Never flag facts you simply cannot verify.",
    defaultSeverity: "critical",
    rollsUpTo: ["Query handling", "Knowledge grounding"],
    detection: "llm",
  },
  {
    code: "IGNORED_STOP_REQUEST",
    label: "Ignored a request to stop or for a human",
    definition:
      "The other party clearly asked to end the call, not to be called again, or to speak to a human, and the agent kept going " +
      "instead of acknowledging and closing or escalating.",
    defaultSeverity: "critical",
    rollsUpTo: ["S2 Conversation handled"],
    detection: "llm",
  },
  {
    code: "UNAUTHORIZED_PROMISE",
    label: "Made a promise it cannot make",
    definition: "The agent promised something outside its authority (discounts, guarantees, selection, outcomes).",
    defaultSeverity: "critical",
    rollsUpTo: ["Query handling"],
    detection: "llm",
  },
  {
    code: "UNPROFESSIONAL_CONDUCT",
    label: "Rude or unprofessional",
    definition: "The agent was rude, dismissive, argumentative, or used inappropriate language.",
    defaultSeverity: "critical",
    rollsUpTo: ["Communication & tone"],
    detection: "llm",
  },
  {
    code: "AGENT_LOOP",
    label: "Stuck in a loop",
    definition:
      "The agent got stuck: it asked the same question or made the same statement three or more times without the conversation " +
      "moving forward, because it ignored a clear answer it had already received or repeated itself mechanically. It is NOT a " +
      "loop when the agent re-asks because the other party's reply was missing, unclear, garbled or a request to repeat " +
      '("sorry?", "what?", silence, an off-topic remark) — especially when the agent rephrases or adds context and the ' +
      "conversation then moves on. Count only repetitions that came after a clear answer or that ignored what was said.",
    defaultSeverity: "major",
    rollsUpTo: ["S2 Conversation handled", "Repetition"],
    detection: "llm",
  },
  {
    code: "CALL_ERROR",
    label: "Call ended on a technical error",
    definition: "The call ended with `connection_error` or `system_error`.",
    defaultSeverity: "critical",
    rollsUpTo: ["S2 Conversation handled"],
    detection: "rule",
  },
  {
    code: "NO_AGENT_SPEECH",
    label: "Agent never spoke",
    definition: "The call connected but the transcript has no agent turn.",
    defaultSeverity: "critical",
    rollsUpTo: ["S1 Connected"],
    detection: "rule",
  },
  {
    code: "DISCRIMINATORY_QUESTION",
    label: "Asked a discriminatory question",
    definition:
      "The agent asked about age, religion, caste, marital status, pregnancy or family planning, or disability (unless the " +
      "instructions explicitly require it for the role).",
    defaultSeverity: "critical",
    rollsUpTo: ["Communication & tone", "Compliance"],
    detection: "llm",
  },
  {
    code: "OUTCOME_MISMATCH",
    label: "Recorded data contradicts the call",
    definition:
      "A value in the recorded outcome clearly contradicts what was said and confirmed in the call (e.g. outcome says notice " +
      "period 30 days, candidate confirmed 90). Only judge this when an outcome is provided.",
    defaultSeverity: "critical",
    rollsUpTo: ["S4 Data saved"],
    detection: "llm",
  },

  // PRD §4.5 proposed additions. New conditions start as Minor (flag only) to check their false-positive rate; raising
  // one to its PRD severity (in each comment) is a deliberate new scorecard version, never automatic.
  {
    // PRD: Critical. Needs per-turn timing (P0-5), so disabled on every scorecard until then. Judged by the LLM for now;
    // once timing exists it can become a rule check (P3-5).
    code: "UNRESPONSIVE_AGENT",
    label: "Went silent",
    definition:
      "After the other party finished speaking, the agent gave no reply for more than 8 seconds, or stopped responding for the " +
      "rest of the call. It does NOT count while the other party is still speaking, or when they asked the agent to hold or wait.",
    defaultSeverity: "minor",
    rollsUpTo: ["S2 Conversation handled"],
    detection: "llm",
  },
  {
    // PRD: Major.
    code: "PREMATURE_HANGUP",
    label: "Ended the call too early",
    definition:
      "The agent ended the call while the other party was in the middle of a question or request, or before a closing step its " +
      "instructions require. It does NOT count when the other party said goodbye or asked to end the call, or when the call dropped.",
    defaultSeverity: "minor",
    rollsUpTo: ["S3 Flow completed"],
    detection: "llm",
  },
  {
    // PRD: Major.
    code: "WRONG_LANGUAGE",
    label: "Ignored the caller's language",
    definition:
      "After the other party switched language or asked the agent to use another one, the agent kept replying in a different " +
      "language. Single borrowed words (e.g. English terms in Hindi speech) do NOT count.",
    defaultSeverity: "minor",
    rollsUpTo: ["Language match"],
    detection: "llm",
  },
  {
    // PRD: Major.
    code: "CONTINUED_AFTER_WRONG_PERSON",
    label: "Pitched to the wrong person",
    definition:
      "The other party said it was a wrong number or that they are not the person the call was for, and the agent continued its " +
      "pitch or questions instead of closing. It does NOT count when the agent only checked who it was speaking to.",
    defaultSeverity: "minor",
    rollsUpTo: ["Flow adherence"],
    detection: "llm",
  },
  {
    // PRD: Major.
    code: "PUSHY_AFTER_DECLINE",
    label: "Pressured after a clear no",
    definition:
      'After a clear "not interested", the agent pushed the offer two or more more times. One polite attempt to address an ' +
      "objection, or answering a question the other party then asked, does NOT count.",
    defaultSeverity: "minor",
    rollsUpTo: ["Communication & tone"],
    detection: "llm",
  },
  {
    // PRD: Critical.
    code: "DENIED_BEING_AI",
    label: "Claimed to be human",
    definition:
      "When sincerely asked whether it is an AI or a bot, the agent said it was a human. It does NOT count when the question was " +
      "a joke or rhetorical.",
    defaultSeverity: "minor",
    rollsUpTo: ["Communication & tone", "Compliance"],
    detection: "llm",
  },
  {
    // PRD: Critical.
    code: "SENSITIVE_DATA_EXPOSED",
    label: "Disclosed sensitive data",
    definition:
      "The agent read out personal, account or internal information before the other party's identity was confirmed, or shared " +
      "another customer's data. It does NOT count for information the other party gave first in this call.",
    defaultSeverity: "minor",
    rollsUpTo: ["Compliance"],
    detection: "llm",
  },
  {
    // PRD: Critical. Needs tool-call logs (P0-13), so disabled on every scorecard until then.
    code: "FALSE_ACTION_CLAIM",
    label: "Claimed an action that did not happen",
    definition:
      "The agent said a booking, message or callback was done when the tool call failed or was never made. Only judge this when " +
      "tool-call logs are provided. It does NOT count when the agent said it will do something later.",
    defaultSeverity: "minor",
    rollsUpTo: ["S4 Data saved"],
    detection: "llm",
  },
  {
    // PRD: Critical. Hansa checks the same thing with OUTCOME_MISMATCH, so only the default scorecard enables this one.
    code: "OUTCOME_MISRECORDED",
    label: "Saved the wrong outcome",
    definition:
      "The saved disposition or variables contradict the transcript (e.g. a demo saved as booked after the caller declined). " +
      "Only judge this when an outcome is provided. A value the call never discussed does NOT count.",
    defaultSeverity: "minor",
    rollsUpTo: ["S4 Data saved"],
    detection: "llm",
  },
  {
    // PRD: Major. Needs the flow's required steps (P0-11) in the judge input, so disabled on every scorecard until then.
    code: "SKIPPED_REQUIRED_STEP",
    label: "Skipped a mandatory step",
    definition:
      "A step marked required in the flow (consent, identity check, disclosure) never happened. Only judge this when the flow's " +
      "required steps are provided. Optional steps, and required steps the call never reached because it ended early, do NOT " +
      "count; optional steps go to Flow adherence.",
    defaultSeverity: "minor",
    rollsUpTo: ["S3 Flow completed", "Flow adherence"],
    detection: "llm",
  },
  {
    // PRD: Major.
    code: "OFF_SCOPE_ADVICE",
    label: "Gave advice outside its role",
    definition:
      "The agent gave legal, medical, financial or other advice its instructions do not allow. It does NOT count when it gave " +
      "facts from its instructions or knowledge base, or declined and referred the other party on.",
    defaultSeverity: "minor",
    rollsUpTo: ["Query handling"],
    detection: "llm",
  },
];

/** The `ended_reason` values `CALL_ERROR` flags, as its definition says (v1: `fail_on_ended_reasons`). */
export const CALL_ERROR_ENDED_REASONS = ["connection_error", "system_error"];

/** A condition code from its label, e.g. "Asked for the OTP" → `ASKED_FOR_THE_OTP`. */
export const codeFromLabel = (label: string) =>
  label
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);

/** Codes are upper snake case, 3–64 characters, starting with a letter. */
export const CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;

/**
 * A definition with its "does not count" clause, worded like the library's: "<what it flags>. It does NOT count when
 * <exception>." A leading "when" in the exception is not repeated.
 */
export function withDoesNotCount(flagsWhen: string, doesNotCount: string): string {
  const what = flagsWhen.trim().replace(/[.\s]+$/, "");
  const except = doesNotCount
    .trim()
    .replace(/^when\s+/i, "")
    .replace(/[.\s]+$/, "");
  return `${what}. It does NOT count when ${except}.`;
}

import { COMMON_FAILURES, defaultRubric } from "./default";
import type { Rubric } from "./types";

/**
 * Hansa — the AI recruiter (`agent_code` "hrms", agent_id 1). Most of its calls are candidate
 * screenings; it also confirms interview slots and sends reminders, so the goal follows the
 * call's purpose from the instructions.
 */
export const hansaRubric: Rubric = {
  version: "hansa-v3",
  context:
    "Hansa is an AI recruiter that phones job candidates. On a screening call it introduces the role, asks a fixed set of " +
    "screening questions (e.g. experience, current CTC, expected CTC, notice period, location), confirms each answer back, and " +
    "closes with next steps. It also makes interview scheduling, slot confirmation and reminder calls.",
  goal: {
    description: "Accomplish the call's recruiting purpose with the candidate's answers or confirmation captured.",
    achieved_if: [
      "Screening: the screening questions (all, or all but one minor one) were asked and answered, and the candidate's interest was established",
      "Scheduling, slot confirmation or reminder: the candidate confirmed or acknowledged the slot or the reminder",
    ],
    not_applicable_if: [
      "The person who answered is not the candidate (wrong number, someone else picked up)",
      "The call reached voicemail, an IVR, or nobody spoke",
      "The audio was unusable, so no conversation took place",
    ],
    reason_codes: {
      ACHIEVED: ["SCREENING_COMPLETED", "SLOT_CONFIRMED"],
      NOT_ACHIEVED: [
        "CANDIDATE_NOT_INTERESTED",
        "CALLBACK_REQUESTED",
        "CANDIDATE_DECLINED_TO_ANSWER",
        "CALL_DROPPED",
        "AGENT_SKIPPED_QUESTIONS",
        "LANGUAGE_BARRIER",
        "OTHER",
      ],
      NOT_APPLICABLE: ["WRONG_PERSON", "VOICEMAIL_OR_NO_ANSWER", "UNUSABLE_AUDIO"],
    },
  },
  failure_conditions: [
    ...COMMON_FAILURES,
    {
      code: "DISCRIMINATORY_QUESTION",
      label: "Asked a discriminatory question",
      definition:
        "The agent asked about age, religion, caste, marital status, pregnancy or family planning, or disability (unless the " +
        "instructions explicitly require it for the role).",
    },
    {
      code: "OUTCOME_MISMATCH",
      label: "Recorded data contradicts the call",
      definition:
        "A value in the recorded outcome clearly contradicts what was said and confirmed in the call (e.g. outcome says notice " +
        "period 30 days, candidate confirmed 90). Only judge this when an outcome is provided.",
    },
  ],
  fail_on_ended_reasons: defaultRubric.fail_on_ended_reasons,
  categories: {
    ...defaultRubric.categories,
    opening: {
      ...defaultRubric.categories.opening,
      checks:
        "Greeted the candidate by name, introduced itself as an AI recruiter and the company, named the role and the purpose of " +
        "the call, and asked whether it was a good time.",
    },
    troubleshooting: {
      ...defaultRubric.categories.troubleshooting,
      checks:
        "Handled what got in the way: unclear or garbled answers (asked again or confirmed instead of guessing), the candidate's " +
        "concerns or objections, confusion about the role, or a request to reschedule.",
    },
    query_handling: {
      checks:
        "Asked every screening question clearly, one at a time, and confirmed key values back (amounts, dates, notice period); " +
        "answered the candidate's questions about the role accurately from its instructions. On slot or reminder calls: gave " +
        "the correct date, time and details and captured the candidate's confirmation.",
      not_applicable_when: "The call ended before any question could be asked (e.g. callback requested, wrong person).",
      anchors: {
        0: "Skipped most questions, never confirmed answers, or gave wrong role or slot details.",
        5: "Asked most questions; skipped one, confirmed only some values, or answered a candidate question vaguely.",
        10: "Every question asked and every key value confirmed; the candidate's questions answered accurately.",
      },
    },
    closure: {
      ...defaultRubric.categories.closure,
      checks: "Recapped the confirmed answers or slot, explained what happens next and when, asked if the candidate had questions, and closed politely.",
    },
  },
  fail_score_cap: 40,
};

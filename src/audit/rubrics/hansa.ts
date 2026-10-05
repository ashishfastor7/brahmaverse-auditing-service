import type { Rubric } from "./types";

/**
 * Hansa — the AI recruiter's candidate screening calls (`agent_code` "hrms").
 *
 * Goal and dimensions follow what Hansa's own outcome extraction collects (ai-service seed
 * `extract-screening-outcome-prompt.ts`): answers to the screening questions, confirmed back.
 */
export const hansaRubric: Rubric = {
  version: "hansa-v1",
  agent_label: "Hansa (AI recruiter)",
  agent_codes: ["hrms", "hansa"],
  context:
    "Hansa is an AI recruiter that phones job candidates to run a short screening: it introduces the role, asks a fixed set of " +
    "screening questions (e.g. current CTC, expected CTC, notice period, location, experience), confirms each answer back, " +
    "and closes with next steps.",
  goal: {
    description: "Complete the candidate screening with confirmed answers and the candidate's interest established.",
    achieved_if: [
      "The agent asked the screening questions (all, or all but one minor one) and the candidate answered them",
      "The candidate's interest in the role, or availability for the next step, was established",
    ],
    not_applicable_if: [
      "The person who answered is not the candidate (wrong number, someone else picked up)",
      "The call reached voicemail, an IVR, or nobody spoke",
      "The audio was unusable, so no conversation took place",
    ],
    reason_codes: {
      ACHIEVED: ["SCREENING_COMPLETED"],
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
    {
      code: "CRITICAL_HALLUCINATION",
      label: "Stated false job facts",
      definition:
        "The agent stated a job fact (salary/CTC range, location, company, role, work mode, interview process, dates) that is " +
        "contradicted by, or absent from, the agent's instructions and call variables. Only judge this when the instructions or " +
        "variables are provided; do not flag facts you simply cannot verify.",
    },
    {
      code: "DISCRIMINATORY_QUESTION",
      label: "Asked a discriminatory question",
      definition:
        "The agent asked about age, religion, caste, marital status, pregnancy or family planning, or disability (unless the " +
        "instructions explicitly require it for the role).",
    },
    {
      code: "IGNORED_STOP_REQUEST",
      label: "Ignored a request to stop or for a human",
      definition:
        "The candidate clearly asked to end the call, not to be called again, or to speak to a human, and the agent kept going " +
        "instead of acknowledging and closing or escalating.",
    },
    {
      code: "UNAUTHORIZED_PROMISE",
      label: "Made a promise it cannot make",
      definition: "The agent promised selection, a job offer, a specific salary, or anything else outside a screening agent's authority.",
    },
    {
      code: "OUTCOME_MISMATCH",
      label: "Recorded data contradicts the call",
      definition:
        "A value in the recorded outcome clearly contradicts what was said and confirmed in the call (e.g. outcome says notice " +
        "period 30 days, candidate confirmed 90). Only judge this when an outcome is provided.",
    },
    {
      code: "UNPROFESSIONAL_CONDUCT",
      label: "Rude or unprofessional",
      definition: "The agent was rude, dismissive, argumentative, or used inappropriate language.",
    },
    {
      code: "AGENT_LOOP",
      label: "Stuck in a loop",
      definition: "The agent repeated the same question or statement three or more times without making progress.",
    },
  ],
  fail_on_ended_reasons: ["connection_error", "system_error"],
  dimensions: [
    {
      key: "intent_understanding",
      label: "Intent understanding",
      weight: 15,
      checks: "Grasped what the candidate meant and responded to it, including questions the candidate asked.",
      anchors: {
        0: "Repeatedly misread the candidate or answered a different question.",
        2: "Mostly understood, with one clear misread.",
        4: "Understood every turn, including indirect answers and the candidate's own questions.",
      },
    },
    {
      key: "question_coverage",
      label: "Screening question coverage",
      weight: 20,
      checks: "Asked all the screening questions, in a sensible order, without skipping or merging them confusingly.",
      anchors: {
        0: "Skipped most screening questions.",
        2: "Asked most questions; skipped one or asked two at once in a confusing way.",
        4: "Asked every screening question clearly, one at a time.",
      },
    },
    {
      key: "answer_confirmation",
      label: "Answer confirmation",
      weight: 15,
      checks:
        "Restated key values (amounts, dates, notice period) back to the candidate and clarified unclear answers instead of guessing.",
      anchors: {
        0: "Never confirmed values; proceeded on unclear answers.",
        2: "Confirmed some key values; let one unclear answer pass.",
        4: "Confirmed every key value and clarified anything unclear.",
      },
    },
    {
      key: "active_listening",
      label: "Active listening",
      weight: 15,
      checks: "Did not re-ask information already given; acknowledged what the candidate said.",
      anchors: {
        0: "Re-asked already-given information two or more times (count each repeat), or ignored what the candidate said.",
        2: "Exactly one lapse: re-asked one answer once, or ignored one remark.",
        4: "Referred back to earlier answers accurately; never repeated a question needlessly.",
      },
    },
    {
      key: "clarity_conciseness",
      label: "Clarity and conciseness",
      weight: 10,
      checks: "Short, plain sentences suited to a phone call; no rambling or jargon.",
      anchors: {
        0: "Long, confusing or jargon-heavy turns throughout.",
        2: "Generally clear, with some overly long or confusing turns.",
        4: "Every turn short, clear and easy to follow by ear.",
      },
    },
    {
      key: "empathy_tone",
      label: "Empathy and tone",
      weight: 10,
      checks: "Polite, warm, and adapted to the candidate's mood (hesitation, irritation, hurry).",
      anchors: {
        0: "Cold, robotic or tone-deaf to the candidate's mood.",
        2: "Polite but did not adapt when the candidate's mood changed.",
        4: "Warm throughout and adapted well to the candidate's mood.",
      },
    },
    {
      key: "flow_and_closing",
      label: "Flow and closing",
      weight: 15,
      checks: "Proper introduction and purpose, natural progression, and a close with clear next steps.",
      anchors: {
        0: "No proper introduction or close; abrupt or disordered.",
        2: "Introduced and closed, but next steps were vague or the flow was choppy.",
        4: "Clear introduction, smooth flow, and a close with concrete next steps.",
      },
    },
  ],
  fail_score_cap: 40,
};

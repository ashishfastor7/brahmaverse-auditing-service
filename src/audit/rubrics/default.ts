import type { FailureCondition, Rubric } from "./types";

export const COMMON_FAILURES: FailureCondition[] = [
  {
    code: "CRITICAL_HALLUCINATION",
    label: "Stated false facts",
    definition:
      "The agent stated a material fact (price, policy, date, service, product or job detail) that its instructions contradict or " +
      "do not support. When the full instructions are NOT provided, only flag a statement that contradicts the call variables — " +
      "a fact that is merely absent from the variables is not a hallucination. Never flag facts you simply cannot verify.",
  },
  {
    code: "IGNORED_STOP_REQUEST",
    label: "Ignored a request to stop or for a human",
    definition:
      "The other party clearly asked to end the call, not to be called again, or to speak to a human, and the agent kept going " +
      "instead of acknowledging and closing or escalating.",
  },
  {
    code: "UNAUTHORIZED_PROMISE",
    label: "Made a promise it cannot make",
    definition: "The agent promised something outside its authority (discounts, guarantees, selection, outcomes).",
  },
  {
    code: "UNPROFESSIONAL_CONDUCT",
    label: "Rude or unprofessional",
    definition: "The agent was rude, dismissive, argumentative, or used inappropriate language.",
  },
  {
    code: "AGENT_LOOP",
    label: "Stuck in a loop",
    definition:
      "The agent got stuck: it asked the same question or made the same statement three or more times without the conversation " +
      "moving forward, because it ignored a clear answer it had already received or repeated itself mechanically. It is NOT a " +
      "loop when the agent re-asks because the other party's reply was missing, unclear, garbled or a request to repeat " +
      "(\"sorry?\", \"what?\", silence, an off-topic remark) — especially when the agent rephrases or adds context and the " +
      "conversation then moves on. Count only repetitions that came after a clear answer or that ignored what was said.",
  },
];

/** Used for any agent without its own rubric, and as the base the agent rubrics adapt. */
export const defaultRubric: Rubric = {
  version: "default-v3",
  context:
    "An AI voice agent on a phone call (inbound or outbound) with a customer or other party. Its purpose is described by its " +
    "instructions when provided; otherwise infer it from the call.",
  goal: {
    description: "The purpose of the call, as set by the agent's instructions or evident from the call, was accomplished.",
    achieved_if: ["The call's purpose was accomplished (the caller's need was met, or the agent's task was completed)"],
    not_applicable_if: [
      "The person who answered was not the intended person",
      "The call reached voicemail, an IVR, or nobody spoke",
      "The audio was unusable, so no conversation took place",
    ],
    reason_codes: {
      ACHIEVED: ["PURPOSE_ACCOMPLISHED"],
      NOT_ACHIEVED: ["CUSTOMER_NOT_INTERESTED", "CALLBACK_REQUESTED", "CALL_DROPPED", "AGENT_FAILED_TASK", "NEED_NOT_MET", "OTHER"],
      NOT_APPLICABLE: ["WRONG_PERSON", "VOICEMAIL_OR_NO_ANSWER", "UNUSABLE_AUDIO"],
    },
  },
  failure_conditions: COMMON_FAILURES,
  fail_on_ended_reasons: ["connection_error", "system_error"],
  categories: {
    opening: {
      checks:
        "Greeted the other party, introduced itself and the organisation, and set up the call: stated the purpose (outbound) or " +
        "asked how it could help (inbound); checked it was a good time on outbound calls.",
      not_applicable_when: "Never — every connected call has an opening.",
      anchors: {
        0: "No greeting or introduction; launched straight in, or the opening confused the other party.",
        5: "Greeted and introduced, but missed the purpose or the good-time check, or the opening was clumsy.",
        10: "Warm greeting, clear introduction, purpose or offer of help stated, good-time check where needed.",
      },
    },
    communication: {
      checks:
        "Clarity and conciseness suited to a phone call, polite and empathetic tone adapted to the other party's mood, active " +
        "listening (no re-asking information already given), and speaking the other party's language.",
      not_applicable_when: "Never.",
      anchors: {
        0: "Confusing, robotic or tone-deaf; re-asked information two or more times, or ignored what was said.",
        5: "Generally clear and polite, with one clear lapse (a long rambling turn, one re-ask, a missed emotional cue).",
        10: "Clear, concise and warm throughout; listened and adapted; never repeated a question needlessly.",
      },
    },
    troubleshooting: {
      checks:
        "When something went wrong — confusion, a misunderstanding, a mis-hearing or garbled answer, an objection, a complaint or " +
        "a problem to solve — the agent noticed it, asked clarifying questions, and resolved or recovered from it.",
      not_applicable_when: "Nothing in the call needed troubleshooting: no confusion, problem, objection or mis-hearing came up.",
      anchors: {
        0: "Ignored or worsened the problem; carried on with wrong information or left the other party confused.",
        5: "Noticed the problem and partly resolved it, or resolved it clumsily.",
        10: "Spotted the problem quickly, clarified, and fully resolved or recovered from it.",
      },
    },
    query_handling: {
      checks:
        "Answered the other party's questions accurately and completely (per its instructions, without inventing facts), and " +
        "gathered the information the call required.",
      not_applicable_when: "The other party asked nothing and the call required no information to be given or gathered.",
      anchors: {
        0: "Questions went unanswered or were answered wrongly; required information was not gathered.",
        5: "Answered most questions or gathered most information, with a gap or an imprecise answer.",
        10: "Every question answered accurately and completely; all required information gathered and confirmed.",
      },
    },
    closure: {
      checks:
        "Ended the call well: summarised or confirmed what was agreed, stated next steps, offered further help, closed politely, " +
        "and ended at the right time (honouring a request to end).",
      not_applicable_when: "The call dropped or was cut off before any close was possible.",
      anchors: {
        0: "Abrupt or missing close; no next steps; or kept talking after the other party wanted to end.",
        5: "Polite close, but next steps or confirmation were vague or missing.",
        10: "Clear confirmation and next steps, offer of further help, and a warm, timely goodbye.",
      },
    },
  },
  fail_score_cap: 40,
};

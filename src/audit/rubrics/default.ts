import type { Rubric } from "./types";

/** Used for any agent without its own rubric yet, so every call still gets audited. */
export const defaultRubric: Rubric = {
  version: "default-v1",
  agent_label: "Voice agent",
  agent_codes: [],
  context: "An AI voice agent on a phone call with a customer. Its purpose is described by its instructions, when provided.",
  goal: {
    description: "The purpose of the call, as set by the agent's instructions, was accomplished.",
    achieved_if: ["The call's purpose (per the agent's instructions, or evident from the call) was accomplished"],
    not_applicable_if: [
      "The person who answered was not the intended person",
      "The call reached voicemail, an IVR, or nobody spoke",
      "The audio was unusable, so no conversation took place",
    ],
    reason_codes: {
      ACHIEVED: ["PURPOSE_ACCOMPLISHED"],
      NOT_ACHIEVED: ["CUSTOMER_NOT_INTERESTED", "CALLBACK_REQUESTED", "CALL_DROPPED", "AGENT_FAILED_TASK", "OTHER"],
      NOT_APPLICABLE: ["WRONG_PERSON", "VOICEMAIL_OR_NO_ANSWER", "UNUSABLE_AUDIO"],
    },
  },
  failure_conditions: [
    {
      code: "CRITICAL_HALLUCINATION",
      label: "Stated false facts",
      definition:
        "The agent stated a material fact (price, policy, date, product detail) contradicted by, or absent from, its instructions. " +
        "Only judge this when the instructions are provided.",
    },
    {
      code: "IGNORED_STOP_REQUEST",
      label: "Ignored a request to stop or for a human",
      definition: "The customer clearly asked to end the call or to speak to a human, and the agent kept going.",
    },
    {
      code: "UNAUTHORIZED_PROMISE",
      label: "Made a promise it cannot make",
      definition: "The agent promised something outside its authority (discounts, guarantees, outcomes).",
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
      weight: 20,
      checks: "Grasped what the customer wanted, without answering a different question.",
      anchors: { 0: "Repeatedly misunderstood.", 2: "One clear misread.", 4: "Understood every turn." },
    },
    {
      key: "accuracy_completeness",
      label: "Accuracy and completeness",
      weight: 20,
      checks: "Information given was correct and nothing important was missed.",
      anchors: { 0: "Wrong or badly incomplete.", 2: "Mostly right; one omission.", 4: "Correct and complete." },
    },
    {
      key: "clarity_conciseness",
      label: "Clarity and conciseness",
      weight: 15,
      checks: "Easy to follow by ear, no rambling, no jargon.",
      anchors: { 0: "Confusing throughout.", 2: "Some long or confusing turns.", 4: "Clear and concise throughout." },
    },
    {
      key: "active_listening",
      label: "Active listening",
      weight: 15,
      checks: "Did not re-ask known information; acknowledged what was said.",
      anchors: { 0: "Re-asked two or more times.", 2: "One lapse.", 4: "No lapses." },
    },
    {
      key: "empathy_tone",
      label: "Empathy and tone",
      weight: 15,
      checks: "Appropriate to the customer's emotional state.",
      anchors: { 0: "Tone-deaf.", 2: "Polite but did not adapt.", 4: "Warm and adaptive." },
    },
    {
      key: "flow_and_closing",
      label: "Flow and closing",
      weight: 15,
      checks: "Natural progression, clear next steps, proper close.",
      anchors: { 0: "Abrupt, no close.", 2: "Closed with vague next steps.", 4: "Smooth flow, concrete next steps." },
    },
  ],
  fail_score_cap: 40,
};

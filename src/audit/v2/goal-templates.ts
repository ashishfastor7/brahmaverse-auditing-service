import type { GoalConfig } from "./config";

/**
 * PRD §3.2 starter business goals. Picking one on the goal screen fills an agent's goal draft with these fields; nothing
 * is used until the draft is published. The wording reaches the judge as the goal definition, so change it like judge
 * input: with approval, and checked with `eval:v2 --draft` before publishing.
 */
export type GoalTemplate = { id: string } & Pick<
  GoalConfig,
  "name" | "description" | "success_criteria" | "partial_success" | "not_applicable_when" | "required_outputs" | "reason_codes"
>;

/** The N/A cases every template shares, worded as in the seeded goal configs (migration 0004). */
const NOT_APPLICABLE = [
  "The person who answered was not the intended person",
  "The call reached voicemail, an IVR, or nobody spoke",
  "The audio was unusable, so no conversation took place",
];
const NA_CODES = ["WRONG_PERSON", "VOICEMAIL_OR_NO_ANSWER", "UNUSABLE_AUDIO"];

export const GOAL_TEMPLATES: GoalTemplate[] = [
  {
    id: "book_demo",
    name: "Book a demo",
    description: "Get the caller to agree to a product demo at a confirmed date and time.",
    success_criteria: ["The caller agreed to a demo with a confirmed date and time"],
    partial_success: ["The caller asked for a callback, or for details on WhatsApp or email"],
    not_applicable_when: [...NOT_APPLICABLE, "The caller is not the decision maker", "The call lasted under 15 seconds"],
    required_outputs: ["demo_datetime", "contact_channel"],
    reason_codes: {
      ACHIEVED: ["DEMO_BOOKED"],
      PARTIAL: ["CALLBACK_REQUESTED", "DETAILS_REQUESTED"],
      NOT_ACHIEVED: ["NOT_INTERESTED", "PRICE", "TIMING", "USING_COMPETITOR", "NEEDS_APPROVAL", "AGENT_CAUSED", "OTHER"],
      NOT_APPLICABLE: [...NA_CODES, "NOT_DECISION_MAKER", "TOO_SHORT"],
    },
  },
  {
    id: "qualify_lead",
    name: "Qualify a lead",
    description: "Ask the qualifying questions and establish whether the lead is a fit.",
    success_criteria: ["The caller answered the qualifying questions and fit was established, either way"],
    partial_success: ["The caller answered some of the questions and asked to continue later"],
    not_applicable_when: [...NOT_APPLICABLE, "The caller is not the decision maker"],
    required_outputs: ["qualification_status"],
    reason_codes: {
      ACHIEVED: ["QUALIFIED", "NOT_A_FIT"],
      PARTIAL: ["CONTINUE_LATER"],
      NOT_ACHIEVED: ["NOT_INTERESTED", "TIMING", "AGENT_CAUSED", "OTHER"],
      NOT_APPLICABLE: [...NA_CODES, "NOT_DECISION_MAKER"],
    },
  },
  {
    id: "confirm_appointment",
    name: "Confirm an appointment",
    description: "Confirm the booked appointment, or agree a new slot.",
    success_criteria: ["The caller confirmed the existing slot or agreed a new one"],
    partial_success: ["The caller asked to reschedule without agreeing a new slot"],
    not_applicable_when: [...NOT_APPLICABLE, "The appointment was already cancelled"],
    required_outputs: ["appointment_status"],
    reason_codes: {
      ACHIEVED: ["CONFIRMED", "RESCHEDULED"],
      PARTIAL: ["RESCHEDULE_PENDING"],
      NOT_ACHIEVED: ["CANCELLED_ON_CALL", "NO_DECISION", "AGENT_CAUSED", "OTHER"],
      NOT_APPLICABLE: [...NA_CODES, "ALREADY_CANCELLED"],
    },
  },
  {
    id: "payment_commitment",
    name: "Collect a payment commitment",
    description: "Get the caller to commit to paying an amount by a date.",
    success_criteria: ["The caller committed to an amount and a date"],
    partial_success: ["The caller committed to pay without a date or an amount"],
    not_applicable_when: [...NOT_APPLICABLE, "The caller has already paid", "The caller disputes the debt (this goes to a human)"],
    required_outputs: ["promised_amount", "promised_date"],
    reason_codes: {
      ACHIEVED: ["PAYMENT_PROMISED"],
      PARTIAL: ["PROMISE_WITHOUT_DETAILS"],
      NOT_ACHIEVED: ["REFUSED", "CANNOT_PAY", "TIMING", "AGENT_CAUSED", "OTHER"],
      NOT_APPLICABLE: [...NA_CODES, "ALREADY_PAID", "DISPUTED"],
    },
  },
  {
    id: "complete_survey",
    name: "Complete a survey",
    description: "Ask every required survey question and record the answers.",
    success_criteria: ["The caller answered every required question"],
    partial_success: ["The caller answered some questions, then stopped"],
    not_applicable_when: [...NOT_APPLICABLE, "The caller declined the survey at the start"],
    required_outputs: ["survey_responses"],
    reason_codes: {
      ACHIEVED: ["SURVEY_COMPLETED"],
      PARTIAL: ["SURVEY_PARTIAL"],
      NOT_ACHIEVED: ["DROPPED_OFF", "AGENT_CAUSED", "OTHER"],
      NOT_APPLICABLE: [...NA_CODES, "DECLINED_AT_START"],
    },
  },
  {
    id: "verify_kyc",
    name: "Verify KYC details",
    description: "Confirm or correct each required identity detail with the caller.",
    success_criteria: ["The caller confirmed or corrected every required detail"],
    partial_success: ["The caller confirmed some of the details"],
    not_applicable_when: [...NOT_APPLICABLE, "The caller refused identity checks for security reasons"],
    required_outputs: ["kyc_status"],
    reason_codes: {
      ACHIEVED: ["KYC_VERIFIED"],
      PARTIAL: ["KYC_PARTIAL"],
      NOT_ACHIEVED: ["DETAILS_MISMATCH", "DOCUMENTS_UNAVAILABLE", "AGENT_CAUSED", "OTHER"],
      NOT_APPLICABLE: [...NA_CODES, "REFUSED_FOR_SECURITY"],
    },
  },
  {
    id: "resolve_support",
    name: "Resolve a support query",
    description: "Diagnose the caller's problem and resolve it, or escalate it with a ticket.",
    success_criteria: ["The problem was resolved, or escalated with a ticket, and the caller confirmed"],
    partial_success: ["A workaround was given and the caller will try it later"],
    not_applicable_when: [...NOT_APPLICABLE, "The caller raised no problem"],
    required_outputs: ["resolution_status"],
    reason_codes: {
      ACHIEVED: ["RESOLVED", "ESCALATED"],
      PARTIAL: ["WORKAROUND_GIVEN"],
      NOT_ACHIEVED: ["UNRESOLVED", "CALLER_LEFT", "AGENT_CAUSED", "OTHER"],
      NOT_APPLICABLE: [...NA_CODES, "NO_PROBLEM_RAISED"],
    },
  },
];

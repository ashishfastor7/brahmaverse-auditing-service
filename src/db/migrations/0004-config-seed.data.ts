/**
 * What migration 0004 seeds. Copied as literals (never imported from `src/audit/rubrics/`) so the migration stays
 * the same after it has been applied, whatever later happens to the code rubrics. `config.test.ts` checks the v1
 * templates against hansa-v3 / default-v3 while those are the code's current rubric versions.
 */

type Severity = "critical" | "major" | "minor";
type Anchors = { 0: string; 5: string; 10: string };
type SeedMetric = {
  key: string;
  name: string;
  description: string;
  checks: string;
  applicability: string;
  anchors: Anchors;
  method: "llm" | "rule" | "audio" | "hybrid";
  weight: number;
  requires: ("audio" | "timestamps" | "tool_calls")[];
  params: Record<string, unknown>;
};
type SeedScorecard = {
  scorecard_id: string;
  version: number;
  name: string;
  /** The version this one was copied from. */
  based_on: number | null;
  pass_threshold: number;
  fail_score_cap: number | null;
  metrics: SeedMetric[];
  conditions: { condition_code: string; severity: Severity; metric_key: string | null }[];
};

export const FAILURE_CONDITIONS: {
  code: string;
  label: string;
  definition: string;
  default_severity: Severity;
  rolls_up_to: string[];
  detection: "rule" | "llm";
}[] = [
  {
    code: "CRITICAL_HALLUCINATION",
    label: "Stated false facts",
    definition:
      "The agent stated a material fact (price, policy, date, service, product or job detail) that its instructions contradict or " +
      "do not support. When the full instructions are NOT provided, only flag a statement that contradicts the call variables — " +
      "a fact that is merely absent from the variables is not a hallucination. Never flag facts you simply cannot verify.",
    default_severity: "critical",
    rolls_up_to: ["Query handling", "Knowledge grounding"],
    detection: "llm",
  },
  {
    code: "IGNORED_STOP_REQUEST",
    label: "Ignored a request to stop or for a human",
    definition:
      "The other party clearly asked to end the call, not to be called again, or to speak to a human, and the agent kept going " +
      "instead of acknowledging and closing or escalating.",
    default_severity: "critical",
    rolls_up_to: ["S2 Conversation handled"],
    detection: "llm",
  },
  {
    code: "UNAUTHORIZED_PROMISE",
    label: "Made a promise it cannot make",
    definition: "The agent promised something outside its authority (discounts, guarantees, selection, outcomes).",
    default_severity: "critical",
    rolls_up_to: ["Query handling"],
    detection: "llm",
  },
  {
    code: "UNPROFESSIONAL_CONDUCT",
    label: "Rude or unprofessional",
    definition: "The agent was rude, dismissive, argumentative, or used inappropriate language.",
    default_severity: "critical",
    rolls_up_to: ["Communication & tone"],
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
    default_severity: "major",
    rolls_up_to: ["S2 Conversation handled", "Repetition"],
    detection: "llm",
  },
  {
    code: "CALL_ERROR",
    label: "Call ended on a technical error",
    definition: "The call ended with `connection_error` or `system_error`.",
    default_severity: "critical",
    rolls_up_to: ["S2 Conversation handled"],
    detection: "rule",
  },
  {
    code: "NO_AGENT_SPEECH",
    label: "Agent never spoke",
    definition: "The call connected but the transcript has no agent turn.",
    default_severity: "critical",
    rolls_up_to: ["S1 Connected"],
    detection: "rule",
  },
  {
    code: "DISCRIMINATORY_QUESTION",
    label: "Asked a discriminatory question",
    definition:
      "The agent asked about age, religion, caste, marital status, pregnancy or family planning, or disability (unless the " +
      "instructions explicitly require it for the role).",
    default_severity: "critical",
    rolls_up_to: ["Communication & tone", "Compliance"],
    detection: "llm",
  },
  {
    code: "OUTCOME_MISMATCH",
    label: "Recorded data contradicts the call",
    definition:
      "A value in the recorded outcome clearly contradicts what was said and confirmed in the call (e.g. outcome says notice " +
      "period 30 days, candidate confirmed 90). Only judge this when an outcome is provided.",
    default_severity: "critical",
    rolls_up_to: ["S4 Data saved"],
    detection: "llm",
  },
];

const COMMON_CONDITIONS = [
  "CRITICAL_HALLUCINATION",
  "IGNORED_STOP_REQUEST",
  "UNAUTHORIZED_PROMISE",
  "UNPROFESSIONAL_CONDUCT",
  "AGENT_LOOP",
  "CALL_ERROR",
  "NO_AGENT_SPEECH",
];
const severity = (code: string) => FAILURE_CONDITIONS.find((c) => c.code === code)!.default_severity;
/** The PRD §4.5 seeded severities; a Major flag zeroes `metric_key` when given. */
const conditions = (codes: string[], metricFor: Record<string, string> = {}) =>
  codes.map((code) => ({ condition_code: code, severity: severity(code), metric_key: metricFor[code] ?? null }));

/** v1 categories (default-v3), as 5 × 20 template metrics. */
const v1Metric = (key: string, name: string, c: { checks: string; not_applicable_when: string; anchors: Anchors }): SeedMetric => ({
  key,
  name,
  description: "",
  checks: c.checks,
  applicability: c.not_applicable_when,
  anchors: c.anchors,
  method: "llm",
  weight: 20,
  requires: [],
  params: {},
});

const DEFAULT_CATEGORIES = {
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
};

/** hansa-v3's categories: the default ones with Hansa's own wording where it has one. */
const HANSA_CATEGORIES: typeof DEFAULT_CATEGORIES = {
  ...DEFAULT_CATEGORIES,
  opening: {
    ...DEFAULT_CATEGORIES.opening,
    checks:
      "Greeted the candidate by name, introduced itself as an AI recruiter and the company, named the role and the purpose of " +
      "the call, and asked whether it was a good time.",
  },
  troubleshooting: {
    ...DEFAULT_CATEGORIES.troubleshooting,
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
    ...DEFAULT_CATEGORIES.closure,
    checks:
      "Recapped the confirmed answers or slot, explained what happens next and when, asked if the candidate had questions, and closed politely.",
  },
};

const v1Template = (categories: typeof DEFAULT_CATEGORIES) => [
  v1Metric("opening", "Opening", categories.opening),
  v1Metric("communication", "Communication", categories.communication),
  v1Metric("troubleshooting", "Troubleshooting", categories.troubleshooting),
  v1Metric("query_handling", "Query handling", categories.query_handling),
  v1Metric("closure", "Closure", categories.closure),
];

/** PRD §4.3's 10 default metrics, 10% each. Interruptions and pronunciation need data that doesn't exist until Phase 3. */
const DEFAULT_V2_METRICS: SeedMetric[] = [
  {
    key: "flow_adherence",
    name: "Flow adherence",
    description: "Skipped steps, notes not followed, steps out of order",
    checks:
      "Followed the agent's step list: reached each step the call allowed, in order, and followed each step's notes. Steps the " +
      "call legitimately never reached (the caller hung up, was not interested, or was the wrong person) are not deductions.",
    applicability: "The call ended before the first step.",
    anchors: {
      0: "Skipped most reachable steps, ran them out of order, or ignored step notes throughout.",
      5: "Reached most steps in order; skipped or reordered one, or missed one step's note.",
      10: "Every reachable step done in order, with its notes followed.",
    },
    method: "llm",
    weight: 10,
    requires: [],
    params: {},
  },
  {
    key: "query_handling",
    name: "Query handling",
    description: "Caller questions answered wrongly, vaguely or not at all; objections left unanswered",
    checks:
      "Answered the caller's questions and objections accurately and completely, from its instructions and knowledge base, " +
      "without inventing facts.",
    applicability: "The caller asked nothing and raised no objection.",
    anchors: {
      0: "Questions or objections went unanswered or were answered wrongly.",
      5: "Answered most, with a gap, a vague answer, or one objection left unaddressed.",
      10: "Every question and objection answered accurately and completely.",
    },
    method: "llm",
    weight: 10,
    requires: [],
    params: {},
  },
  {
    key: "troubleshooting",
    name: "Troubleshooting",
    description:
      "Failure to diagnose and resolve a caller's problem: wrong steps, missing clarifying questions, no resolution or escalation",
    checks:
      "When the caller raised a problem, diagnosed it (asked the clarifying questions it needed), followed its troubleshooting " +
      "steps, and resolved it or escalated.",
    applicability: "The caller raised no problem to solve.",
    anchors: {
      0: "No diagnosis or wrong steps; the problem was left unresolved with no escalation.",
      5: "Diagnosed the problem but resolved it only partly, or skipped a clarifying question or step.",
      10: "Diagnosed quickly with the right questions and resolved or correctly escalated the problem.",
    },
    method: "llm",
    weight: 10,
    requires: [],
    params: {},
  },
  {
    key: "communication_tone",
    name: "Communication & tone",
    description: "Rude, flat or pushy tone; overly long turns",
    checks:
      "Polite, warm and empathetic tone suited to the caller's mood; clear, concise turns suited to a phone call; not flat, rude " +
      "or pushy.",
    applicability: "Never.",
    anchors: {
      0: "Rude, flat or pushy, or turns so long or unclear the caller was lost.",
      5: "Generally polite and clear, with one lapse (a rambling turn, a pushy moment, a missed emotional cue).",
      10: "Warm, clear and concise throughout, adapting to the caller.",
    },
    method: "llm",
    weight: 10,
    requires: [],
    params: {},
  },
  {
    key: "opening_closure",
    name: "Opening & closure",
    description: "Missing greeting, identity check, recap or next step",
    checks:
      "Opening: greeted, introduced itself and the organisation, confirmed it was speaking to the right person, and stated the " +
      "purpose. Closure: recapped what was agreed, stated next steps, and closed politely at the right time.",
    applicability: "Never; a call cut off before any close is judged on its opening.",
    anchors: {
      0: "No greeting or identity check, and no recap or next step.",
      5: "Opening or close incomplete (e.g. no identity check, or a goodbye without next steps).",
      10: "Full opening (greeting, introduction, identity check, purpose) and full close (recap, next step, goodbye).",
    },
    method: "llm",
    weight: 10,
    requires: [],
    params: {},
  },
  {
    key: "language_match",
    name: "Language match",
    description: "Agent not replying in the caller's chosen language, or switching unprompted",
    checks:
      "Replied in the caller's chosen language, switched when the caller switched or asked, and did not switch on its own. " +
      "Single borrowed words (e.g. English terms in Hindi speech) are not a switch.",
    applicability: "Never.",
    anchors: {
      0: "Kept replying in a language the caller did not use or asked to change.",
      5: "Mostly matched the caller, with one unprompted switch or a slow switch after a request.",
      10: "Always in the caller's language; switched promptly when asked.",
    },
    method: "hybrid",
    weight: 10,
    requires: [],
    params: {},
  },
  {
    key: "repetition",
    name: "Repetition",
    description: "The same line or knowledge-base phrase said again and again",
    checks:
      "Did not say the same line or knowledge-base phrase again and again. Re-asking after a missing, unclear or garbled reply, " +
      "or repeating because the caller asked, is not repetition.",
    applicability: "Never.",
    anchors: {
      0: "The same line or phrase repeated three or more times without need.",
      5: "One line repeated needlessly once or twice.",
      10: "No needless repetition.",
    },
    method: "hybrid",
    weight: 10,
    requires: [],
    params: { similarity: 0.85, min_repeats: 3 },
  },
  {
    key: "stalling_filler",
    name: "Stalling & filler words",
    description:
      "Stalling phrases (“Let me check”, “I will get back”) used repeatedly, and excess fillers (“umm”, “actually”, “basically”) " +
      "beyond a normal rate",
    checks:
      "Stalling phrases were not used repeatedly and filler words stayed at a normal rate, counted per 100 agent words " +
      "(params.per_100_words).",
    applicability: "The agent said fewer than 20 words.",
    anchors: {
      0: "Stalling phrases and fillers above `partial` per 100 agent words.",
      5: "Between `full` and `partial` per 100 agent words.",
      10: "At or below `full` per 100 agent words.",
    },
    method: "rule",
    weight: 10,
    requires: [],
    params: {
      stalling_phrases: ["let me check", "i will get back to you", "one moment", "ek minute", "main check karke batata"],
      filler_words: ["umm", "uh", "hmm", "actually", "basically", "matlab"],
      per_100_words: { full: 1, partial: 3 },
    },
  },
  {
    key: "interruptions",
    name: "Interruptions / overlap",
    description: "Agent speaking before the caller finished",
    checks: "Did not start speaking before the caller finished; overlaps over params.overlap_ms count.",
    applicability: "Until per-turn timing exists (Phase 3): every call.",
    anchors: {
      0: "Talked over the caller repeatedly.",
      5: "Talked over the caller once or twice.",
      10: "Never talked over the caller.",
    },
    method: "rule",
    weight: 10,
    requires: ["timestamps"],
    params: { overlap_ms: 300 },
  },
  {
    key: "pronunciation_numbers",
    name: "Pronunciation & numbers",
    description: "Mispronounced words; “200” read as “two zero zero”; numbers in the wrong language",
    checks:
      "Pronounced words correctly and read numbers naturally in the caller's language (“200” as “two hundred”, not “two zero " + "zero”).",
    applicability: "Until audio analysis exists (Phase 3): every call.",
    anchors: {
      0: "Frequent mispronunciations, or numbers read wrongly or in the wrong language.",
      5: "One or two mispronunciations or wrongly read numbers.",
      10: "No mispronunciations; every number read naturally.",
    },
    method: "audio",
    weight: 10,
    requires: ["audio"],
    params: {},
  },
];

/**
 * `hansa` v1 and `default` v1 are the v1 5 × 20 templates: kept only so v1 audits can link to what they were graded
 * on. No agent uses them (assignments need at least 10 metrics). Every agent is graded on the 10 metrics: Hansa on
 * its own copy, which keeps Hansa's two extra conditions.
 */
export const SCORECARDS: SeedScorecard[] = [
  {
    scorecard_id: "hansa",
    version: 1,
    name: "Hansa 5 × 20 (hansa-v3, v1 audits only)",
    based_on: null,
    pass_threshold: 40,
    fail_score_cap: 40,
    metrics: v1Template(HANSA_CATEGORIES),
    conditions: conditions([...COMMON_CONDITIONS, "DISCRIMINATORY_QUESTION", "OUTCOME_MISMATCH"]),
  },
  {
    scorecard_id: "default",
    version: 1,
    name: "Default 5 × 20 (default-v3, v1 audits only)",
    based_on: null,
    pass_threshold: 40,
    fail_score_cap: 40,
    metrics: v1Template(DEFAULT_CATEGORIES),
    conditions: conditions(COMMON_CONDITIONS),
  },
  {
    scorecard_id: "default",
    version: 2,
    name: "Default (10 metrics)",
    based_on: 1,
    pass_threshold: 40,
    fail_score_cap: null,
    metrics: DEFAULT_V2_METRICS,
    conditions: conditions(COMMON_CONDITIONS, { AGENT_LOOP: "repetition" }),
  },
  {
    scorecard_id: "hansa",
    version: 2,
    name: "Hansa (10 metrics)",
    based_on: 1,
    pass_threshold: 40,
    fail_score_cap: null,
    metrics: DEFAULT_V2_METRICS,
    conditions: conditions([...COMMON_CONDITIONS, "DISCRIMINATORY_QUESTION", "OUTCOME_MISMATCH"], { AGENT_LOOP: "repetition" }),
  },
];

/** Which scorecard version each agent uses: the 10 metrics, for every agent. */
export const ASSIGNMENTS = [
  { agent_code: "hrms", scorecard_id: "hansa", scorecard_version: 2 },
  { agent_code: "project-manager", scorecard_id: "default", scorecard_version: 2 },
  { agent_code: "caller", scorecard_id: "default", scorecard_version: 2 },
];

const DEFAULT_GOAL = {
  name: "Call purpose accomplished",
  description: "The purpose of the call, as set by the agent's instructions or evident from the call, was accomplished.",
  success_criteria: ["The call's purpose was accomplished (the caller's need was met, or the agent's task was completed)"],
  not_applicable_when: [
    "The person who answered was not the intended person",
    "The call reached voicemail, an IVR, or nobody spoke",
    "The audio was unusable, so no conversation took place",
  ],
  reason_codes: {
    ACHIEVED: ["PURPOSE_ACCOMPLISHED"],
    NOT_ACHIEVED: ["CUSTOMER_NOT_INTERESTED", "CALLBACK_REQUESTED", "CALL_DROPPED", "AGENT_FAILED_TASK", "NEED_NOT_MET", "OTHER"],
    NOT_APPLICABLE: ["WRONG_PERSON", "VOICEMAIL_OR_NO_ANSWER", "UNUSABLE_AUDIO"],
  },
};

const HANSA_GOAL = {
  name: "Recruiting call purpose",
  description: "Accomplish the call's recruiting purpose with the candidate's answers or confirmation captured.",
  success_criteria: [
    "Screening: the screening questions (all, or all but one minor one) were asked and answered, and the candidate's interest was established",
    "Scheduling, slot confirmation or reminder: the candidate confirmed or acknowledged the slot or the reminder",
  ],
  not_applicable_when: [
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
};

/** 8 s is the PRD §4.5 `UNRESPONSIVE_AGENT` limit; flow steps null = read them per call (P0-11). */
const SYSTEM_CHECKS = { silence_limit_s: 8, required_variables: [] as string[], flow_steps: null };

export const GOAL_CONFIGS = [
  { agent_code: "hrms", version: 1, ...HANSA_GOAL, system_checks: SYSTEM_CHECKS },
  { agent_code: "project-manager", version: 1, ...DEFAULT_GOAL, system_checks: SYSTEM_CHECKS },
  { agent_code: "caller", version: 1, ...DEFAULT_GOAL, system_checks: SYSTEM_CHECKS },
];

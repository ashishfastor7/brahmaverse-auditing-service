/** One transcript turn. `turn` is 1-based and is what evidence points at. */
export type Turn = { turn: number; speaker: string; text: string };

/** A finished call, normalized from whichever source delivered it (event, RPC listing, file export). */
export type AuditInput = {
  source: "voice_call_logs";
  call_id: number;
  business_id: number;
  agent_id: number | null;
  agent_code: string | null;
  prompt_code: string | null;
  variables: Record<string, string | number | boolean>;
  status: string;
  call_type: string | null;
  voice_provider: string | null;
  is_playground: boolean;
  duration: number | null;
  ended_reason: string | null;
  recording_url: string | null;
  summary: string | null;
  outcome: Record<string, unknown> | null;
  transcript: Turn[];
  call_created_at: string | null;
};

/** The agent's instructions, when they could be fetched. */
export type AgentPrompt = { prompt_id: number; prompt_code: string; version: number; system_prompt: string };

export type Evidence = { turn: number; quote: string; valid?: boolean };

/**
 * One scorecard category. `score` is in points out of `max` (20). `applicable: false` when the call
 * never needed this category (e.g. nothing to troubleshoot); it is then left out of the total.
 */
export type MetricResult = { label: string; applicable: boolean; score: number | null; max: number; reasoning: string; evidence: Evidence[] };

export type FailureReason = {
  code: string;
  source: "rule" | "llm";
  explanation: string;
  /** Every turn involved (e.g. each repetition of a loop). Empty for call-level failures. */
  evidence: Evidence[];
  /** The first evidence item, kept for older readers. */
  turn: number | null;
  quote: string | null;
};

export type SuccessResult = "PASS" | "FAIL";
export type GoalResult = "ACHIEVED" | "NOT_ACHIEVED" | "NOT_APPLICABLE";
export type Sentiment = "positive" | "neutral" | "negative" | "frustrated" | "confused";

/** The audit result — the shape the dashboard reads. */
export type AuditResult = {
  /** Sum of applicable category points, scaled to 100 (capped if the call failed).
   * null when no quality dimension applied (e.g. wrong person picked up) — nothing to score. */
  overall_score: number | null;
  quality_score: number | null;
  call_success: { result: SuccessResult; failure_reasons: FailureReason[] };
  call_goal: { result: GoalResult; reason_code: string; explanation: string; evidence: Evidence[] };
  metrics: Record<string, MetricResult>;
  /** What happened on the call, in a few sentences. */
  call_summary: string;
  went_well: { point: string; turn: number; quote: string; valid?: boolean }[];
  /** What the agent should do differently, each with a concrete suggestion. */
  improvements: { point: string; suggestion: string; turn: number; quote: string; severity: "low" | "medium" | "high"; valid?: boolean }[];
  sentiment: { start: Sentiment; end: Sentiment; note: string };
  /** The auditor's overall judgement of the call. */
  conclusion: string;
  auditor_confidence: number;
  needs_review: boolean;
  rubric_version: string;
  agent_label: string | null;
  judge: {
    model: string;
    prompt_used: { prompt_code: string; version: number } | null;
    transcript_quality: "good" | "fair" | "poor";
    evidence_validity: number;
    self_confidence: number;
  };
};

/** A 0–4 quality dimension with anchored levels, so the judge scores against definitions, not vibes. */
export type Dimension = {
  key: string;
  label: string;
  weight: number;
  checks: string;
  anchors: { 0: string; 2: string; 4: string };
};

/** A condition that fails the call on its own, whatever the quality score. Detected by the LLM. */
export type FailureCondition = { code: string; label: string; definition: string };

export type Rubric = {
  /** Stored on every result; bump it whenever anything below changes, so old scores stay comparable. */
  version: string;
  agent_label: string;
  agent_codes: string[];
  /** What the agent is for, given to the judge as context. */
  context: string;
  goal: {
    description: string;
    achieved_if: string[];
    not_applicable_if: string[];
    reason_codes: {
      ACHIEVED: string[];
      NOT_ACHIEVED: string[];
      NOT_APPLICABLE: string[];
    };
  };
  failure_conditions: FailureCondition[];
  /** `ended_reason` values that fail the call as a technical failure. */
  fail_on_ended_reasons: string[];
  dimensions: Dimension[];
  /** A failed call's overall score is capped here: a call that broke a rule cannot look good. */
  fail_score_cap: number;
};

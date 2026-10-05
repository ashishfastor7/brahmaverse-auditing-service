/**
 * The scorecard every call is graded on, whatever the agent: five categories of 20 points each.
 * Rubrics only change what each category means for their agent, so scores stay comparable.
 */
export const SCORECARD = [
  { key: "opening", label: "Opening" },
  { key: "communication", label: "Communication" },
  { key: "troubleshooting", label: "Troubleshooting" },
  { key: "query_handling", label: "Query handling" },
  { key: "closure", label: "Closure" },
] as const;

export type CategoryKey = (typeof SCORECARD)[number]["key"];

export const POINTS_PER_CATEGORY = 20;
/** The judge scores 0–10 against anchors; points = score × 2. */
export const JUDGE_SCALE = 10;

/** What one category means for this agent, with anchors so the judge scores against definitions. */
export type CategoryDefinition = {
  checks: string;
  /** When the category does not apply to a call (then it is left out of the total, not scored 0). */
  not_applicable_when: string;
  anchors: { 0: string; 5: string; 10: string };
};

/** A condition that fails the call on its own, whatever the score. Detected by the LLM. */
export type FailureCondition = { code: string; label: string; definition: string };

export type Rubric = {
  /** Stored on every result; bump it whenever anything below changes, so old scores stay comparable. */
  version: string;
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
  categories: Record<CategoryKey, CategoryDefinition>;
  /** A failed call's overall score is capped here: a call that broke a rule cannot look good. */
  fail_score_cap: number;
};

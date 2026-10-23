import type { Agent } from "@/audit/rubrics";

/**
 * v2 configuration as stored in `scorecard`, `metric`, `scorecard_condition`, `scorecard_assignment` and
 * `goal_config` (migration 0003). Pure: no I/O, see `src/db/config-store.ts`.
 *
 * - A scorecard version is a frozen set of metrics, weights and conditions. Editing one means publishing a new
 *   version; published versions never change (the database rejects it).
 * - Each agent points at one published scorecard version (`scorecard_assignment`). Attaching an agent only moves
 *   that pointer, so it never creates a version.
 * - A goal config belongs to one agent; the agent uses its latest published version.
 */
export type ConfigStatus = "draft" | "published";
export type Severity = "critical" | "major" | "minor";
export type MetricMethod = "llm" | "rule" | "audio" | "hybrid";
/** Data a metric needs beyond the transcript. A metric whose requirements are missing is N/A on every call. */
export type Requirement = "audio" | "timestamps" | "tool_calls";
export type BusinessOutcome = "ACHIEVED" | "PARTIAL" | "NOT_ACHIEVED" | "NOT_APPLICABLE";

/** Same shape as a v1 `CategoryDefinition`, without `not_applicable_when` (that is `Metric.applicability`). */
export type MetricRubric = { checks: string; anchors: { 0: string; 5: string; 10: string } };

export type Metric = {
  id: number;
  key: string;
  position: number;
  name: string;
  description: string;
  rubric: MetricRubric;
  /** When the metric is N/A (then its weight is re-normalised away, not scored 0). */
  applicability: string;
  method: MetricMethod;
  /** Default share of the score, 0–100; a scorecard's weights total 100. */
  weight: number;
  scale: number;
  auto_fail: boolean;
  evidence_required: boolean;
  requires: Requirement[];
  params: Record<string, unknown>;
};

export type ScorecardCondition = {
  condition_code: string;
  enabled: boolean;
  severity: Severity;
  /** The metric a Major flag sets to 0; null when the condition has none on this scorecard. */
  metric_key: string | null;
};

export type ScorecardHeader = {
  scorecard_id: string;
  version: number;
  status: ConfigStatus;
  name: string;
  /** The version this one was copied from; publishing moves the agents on that version to this one. */
  based_on: number | null;
  pass_threshold: number;
  /** v1 templates only: a failed call's score is capped here. */
  fail_score_cap: number | null;
  published_at: Date | null;
};

export type ScorecardVersion = ScorecardHeader & { metrics: Metric[]; conditions: ScorecardCondition[] };

export type GoalConfig = {
  agent_code: string;
  version: number;
  status: ConfigStatus;
  name: string;
  description: string;
  success_criteria: string[];
  partial_success: string[];
  not_applicable_when: string[];
  required_outputs: string[];
  reason_codes: Partial<Record<BusinessOutcome, string[]>>;
  system_checks: { silence_limit_s: number; required_variables: string[]; flow_steps: string[] | null };
  published_at: Date | null;
};

/** The agent's goal config: its highest published version. Drafts never apply. */
export function latestPublished<T extends { version: number; status: ConfigStatus }>(versions: T[]): T | null {
  return versions.filter((v) => v.status === "published").sort((a, b) => b.version - a.version)[0] ?? null;
}

export type ConfigUnavailable = "unknown_agent" | "no_scorecard_assigned" | "no_published_goal";
export type ResolvedConfig<S = ScorecardHeader> =
  | { scorecard: S; goal: GoalConfig; reason: null }
  | { scorecard: null; goal: null; reason: ConfigUnavailable };

/**
 * P1-3: the scorecard and goal config an agent (resolved with `agentFor`) is audited with, or why there are none.
 * `assigned` is the version its `scorecard_assignment` points at; the database only lets it point at a published one.
 */
export function resolveConfig(
  agent: Pick<Agent, "code"> | null,
  found: { assigned: ScorecardHeader | null; goals: GoalConfig[] },
): ResolvedConfig {
  if (!agent) return { scorecard: null, goal: null, reason: "unknown_agent" };
  if (found.assigned?.status !== "published") return { scorecard: null, goal: null, reason: "no_scorecard_assigned" };
  const goal = latestPublished(found.goals.filter((g) => g.agent_code === agent.code));
  if (!goal) return { scorecard: null, goal: null, reason: "no_published_goal" };
  return { scorecard: found.assigned, goal, reason: null };
}

/** Every scorecard an agent uses has at least the PRD §4.3 metrics; the database enforces it on assignment too. */
export const MIN_METRICS = 10;

/** Why a scorecard draft can't be published; empty when it can. */
export function validateScorecard(s: Pick<ScorecardVersion, "metrics" | "conditions">): string[] {
  const errors: string[] = [];
  if (s.metrics.length < MIN_METRICS) errors.push(`${s.metrics.length} metrics, at least ${MIN_METRICS} needed`);
  const keys = s.metrics.map((m) => m.key);
  for (const key of new Set(keys.filter((k, i) => keys.indexOf(k) !== i))) errors.push(`duplicate metric ${key}`);
  const total = Math.round(s.metrics.reduce((sum, m) => sum + m.weight, 0) * 10) / 10;
  if (s.metrics.length && total !== 100) errors.push(`weights total ${total}, not 100`);
  for (const c of s.conditions) {
    if (c.metric_key && !keys.includes(c.metric_key)) errors.push(`${c.condition_code} links to unknown metric ${c.metric_key}`);
  }
  return errors;
}

/** Why a goal config draft can't be published; empty when it can. */
export function validateGoalConfig(g: Pick<GoalConfig, "name" | "success_criteria">): string[] {
  const errors: string[] = [];
  if (!g.name.trim()) errors.push("no name");
  if (g.success_criteria.length === 0) errors.push("no success criteria");
  return errors;
}

/**
 * Keys of the metrics that are N/A on every call because data they need doesn't exist yet (e.g. interruptions need
 * timestamps, pronunciation needs audio, until Phase 3). The scorer leaves them out, so their weight is re-normalised
 * away instead of scoring 0.
 */
export function unavailableMetrics(metrics: Pick<Metric, "key" | "requires">[], available: Requirement[]): string[] {
  return metrics.filter((m) => m.requires.some((r) => !available.includes(r))).map((m) => m.key);
}

import { FAILURE_CONDITIONS, GOAL_CONFIGS, SCORECARDS } from "@/db/migrations/0004-config-seed.data";
import { PROPOSED_CONDITIONS, V3_SCORECARDS } from "@/db/migrations/0010-proposed-conditions.data";
import { SIGNAL_PARAMS } from "@/db/migrations/0011-signal-params.data";
import type { GoalConfig, ScorecardVersion } from "./config";
import type { ConditionDefinition } from "./judge/prompt";

/**
 * The published config the migrations seed, rebuilt without a database: v4 of `hansa` / `default` (0004's 10 metrics,
 * v2's conditions plus 0010's, 0011's signal params) and the agents' goal config v1. For unit tests and the fixture
 * recorder, which must grade on what the agents really use. `config.test.ts` checks the seed files themselves.
 */
export function seededScorecard(scorecard_id: "hansa" | "default"): ScorecardVersion {
  const v2 = SCORECARDS.find((s) => s.scorecard_id === scorecard_id && s.version === 2)!;
  const v3 = V3_SCORECARDS.find((s) => s.scorecard_id === scorecard_id)!;
  return {
    scorecard_id,
    version: 4,
    status: "published",
    name: v2.name,
    based_on: 3,
    pass_threshold: v2.pass_threshold,
    fail_score_cap: null,
    published_at: null,
    metrics: v2.metrics.map((m, i) => ({
      id: i + 1,
      key: m.key,
      position: i + 1,
      name: m.name,
      description: m.description,
      rubric: { checks: m.checks, anchors: m.anchors },
      applicability: m.applicability,
      method: m.method,
      weight: m.weight,
      scale: 10,
      auto_fail: false,
      evidence_required: true,
      requires: m.requires,
      params: SIGNAL_PARAMS[m.key] ?? m.params,
    })),
    conditions: [...v2.conditions.map((c) => ({ ...c, enabled: true })), ...v3.conditions],
  };
}

export function seededGoal(agent_code: "hrms" | "caller" | "project-manager"): GoalConfig {
  const g = GOAL_CONFIGS.find((x) => x.agent_code === agent_code)!;
  return { partial_success: [], required_outputs: [], ...g, status: "published", published_at: null };
}

export const seededDefinitions = (): ConditionDefinition[] =>
  [...FAILURE_CONDITIONS, ...PROPOSED_CONDITIONS].map(({ code, label, definition, detection, rolls_up_to }) => ({ code, label, definition, detection, rolls_up_to }));

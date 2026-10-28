import { describe, expect, it } from "bun:test";
import { COMMON_FAILURES, defaultRubric } from "@/audit/rubrics/default";
import { hansaRubric } from "@/audit/rubrics/hansa";
import { SCORECARD } from "@/audit/rubrics/types";
import { ASSIGNMENTS, FAILURE_CONDITIONS, GOAL_CONFIGS, SCORECARDS } from "@/db/migrations/0004-config-seed.data";
import { DISABLED_UNTIL_DATA, PROPOSED_CONDITIONS, V3_SCORECARDS } from "@/db/migrations/0010-proposed-conditions.data";
import { CONDITION_LIBRARY } from "./conditions";
import {
  type GoalConfig,
  type Metric,
  type ScorecardHeader,
  MIN_METRICS,
  latestPublished,
  resolveConfig,
  unavailableMetrics,
  validateGoalConfig,
  validateScorecard,
} from "./config";

const at = (day: number) => new Date(Date.UTC(2026, 9, day));
const scorecard = (scorecard_id: string, version: number, over: Partial<ScorecardHeader> = {}): ScorecardHeader => ({
  scorecard_id,
  version,
  status: "published",
  name: `${scorecard_id} v${version}`,
  based_on: null,
  pass_threshold: 40,
  fail_score_cap: null,
  published_at: at(version),
  ...over,
});
const goal = (agent_code: string, version: number, over: Partial<GoalConfig> = {}): GoalConfig => ({
  agent_code,
  version,
  status: "published",
  name: "Book a demo",
  description: "",
  success_criteria: ["Caller agreed to a demo"],
  partial_success: [],
  not_applicable_when: [],
  required_outputs: [],
  reason_codes: {},
  system_checks: { silence_limit_s: 8, required_variables: [], flow_steps: null },
  published_at: at(version),
  ...over,
});
const metric = (key: string, weight: number, requires: Metric["requires"] = []): Metric => ({
  id: 0,
  key,
  position: 0,
  name: key,
  description: "",
  rubric: { checks: "", anchors: { 0: "", 5: "", 10: "" } },
  applicability: "",
  method: "llm",
  weight,
  scale: 10,
  auto_fail: false,
  evidence_required: true,
  requires,
  params: {},
});

const goals = [goal("caller", 1), goal("caller", 2), goal("caller", 3, { status: "draft", published_at: null }), goal("hrms", 1)];

describe("resolveConfig (P1-3)", () => {
  it("returns unknown_agent when the call's agent can't be resolved", () => {
    expect(resolveConfig(null, { assigned: scorecard("default", 2), goals })).toEqual({
      scorecard: null,
      goal: null,
      reason: "unknown_agent",
    });
  });

  it("uses the scorecard version the agent is assigned to, and the agent's latest published goal config", () => {
    const caller = resolveConfig({ code: "caller" }, { assigned: scorecard("default", 2), goals });
    expect([caller.scorecard?.scorecard_id, caller.scorecard?.version, caller.goal?.agent_code, caller.goal?.version]).toEqual([
      "default",
      2,
      "caller",
      2,
    ]);
  });

  it("an agent with no assignment (or pointing at a draft) has no scorecard", () => {
    expect(resolveConfig({ code: "caller" }, { assigned: null, goals }).reason).toBe("no_scorecard_assigned");
    const draft = scorecard("default", 3, { status: "draft", published_at: null });
    expect(resolveConfig({ code: "caller" }, { assigned: draft, goals }).reason).toBe("no_scorecard_assigned");
  });

  it("reports a missing goal config; another agent's or a draft goal config never counts", () => {
    expect(resolveConfig({ code: "project-manager" }, { assigned: scorecard("default", 1), goals }).reason).toBe("no_published_goal");
    const draftOnly = [goal("caller", 1, { status: "draft", published_at: null })];
    expect(resolveConfig({ code: "caller" }, { assigned: scorecard("default", 2), goals: draftOnly }).reason).toBe("no_published_goal");
  });

  it("latestPublished skips drafts", () => {
    expect(latestPublished(goals.filter((g) => g.agent_code === "caller"))?.version).toBe(2);
    expect(latestPublished([])).toBeNull();
  });
});

describe("validateScorecard", () => {
  const ten = Array.from({ length: 10 }, (_, i) => metric(`m${i}`, 10));
  const ok = { metrics: ten, conditions: [] };

  it("accepts weights that total 100.0", () => {
    expect(validateScorecard(ok)).toEqual([]);
    const uneven = [metric("a", 12), metric("b", 8), ...ten.slice(2), metric("c", 0)];
    expect(validateScorecard({ ...ok, metrics: uneven })).toEqual([]);
  });

  it("rejects a total other than 100, duplicate keys and fewer than 10 metrics", () => {
    expect(validateScorecard({ ...ok, metrics: [...ten.slice(1), metric("m0", 9.9)] })).toEqual(["weights total 99.9, not 100"]);
    expect(validateScorecard({ ...ok, metrics: [...ten.slice(1), metric("m1", 10)] })).toEqual(["duplicate metric m1"]);
    expect(validateScorecard({ ...ok, metrics: [] })).toEqual(["0 metrics, at least 10 needed"]);
    // The v1 5 × 20 can't be published again for an agent.
    expect(validateScorecard({ ...ok, metrics: ten.slice(0, 5).map((m) => ({ ...m, weight: 20 })) })).toEqual([
      "5 metrics, at least 10 needed",
    ]);
  });

  it("rejects a condition linked to a metric the scorecard doesn't have", () => {
    const conditions = [{ condition_code: "AGENT_LOOP", enabled: true, severity: "major" as const, metric_key: "repetition" }];
    expect(validateScorecard({ ...ok, conditions })).toEqual(["AGENT_LOOP links to unknown metric repetition"]);
  });
});

describe("validateGoalConfig", () => {
  it("needs a name and at least one success criterion", () => {
    expect(validateGoalConfig(goal("caller", 1))).toEqual([]);
    expect(validateGoalConfig(goal("caller", 1, { name: "  ", success_criteria: [] }))).toEqual(["no name", "no success criteria"]);
  });
});

describe("unavailableMetrics", () => {
  const metrics = [metric("flow", 10), metric("interruptions", 10, ["timestamps"]), metric("pronunciation", 10, ["audio"])];

  it("marks metrics whose data doesn't exist yet as N/A", () => {
    expect(unavailableMetrics(metrics, [])).toEqual(["interruptions", "pronunciation"]);
    expect(unavailableMetrics(metrics, ["timestamps"])).toEqual(["pronunciation"]);
    expect(unavailableMetrics(metrics, ["timestamps", "audio"])).toEqual([]);
  });
});

describe("0004 seed", () => {
  const caller = SCORECARDS.find((s) => s.scorecard_id === "default" && s.version === 2)!;

  it("default v2: the 10 PRD §4.3 metrics at 10 each, valid to publish", () => {
    expect(caller.metrics.map((m) => m.name)).toEqual([
      "Flow adherence",
      "Query handling",
      "Troubleshooting",
      "Communication & tone",
      "Opening & closure",
      "Language match",
      "Repetition",
      "Stalling & filler words",
      "Interruptions / overlap",
      "Pronunciation & numbers",
    ]);
    expect(caller.metrics.every((m) => m.weight === 10)).toBe(true);
    const asMetrics = caller.metrics.map((m) => metric(m.key, m.weight, m.requires));
    expect(validateScorecard({ metrics: asMetrics, conditions: caller.conditions.map((c) => ({ ...c, enabled: true })) })).toEqual([]);
  });

  it("every agent is graded on the 10 metrics; the 5 × 20 templates are only for v1 audits", () => {
    expect(ASSIGNMENTS).toEqual([
      { agent_code: "hrms", scorecard_id: "hansa", scorecard_version: 2 },
      { agent_code: "project-manager", scorecard_id: "default", scorecard_version: 2 },
      { agent_code: "caller", scorecard_id: "default", scorecard_version: 2 },
    ]);
    expect(caller.based_on).toBe(1);
    for (const a of ASSIGNMENTS) {
      const s = SCORECARDS.find((s) => s.scorecard_id === a.scorecard_id && s.version === a.scorecard_version)!;
      expect(s.metrics.length).toBeGreaterThanOrEqual(MIN_METRICS);
    }
    // Hansa: the same 10 metrics, plus its two extra conditions.
    const hansa = SCORECARDS.find((s) => s.scorecard_id === "hansa" && s.version === 2)!;
    expect(hansa.metrics).toEqual(caller.metrics);
    expect(hansa.conditions.map((c) => c.condition_code).sort()).toEqual(
      [...caller.conditions.map((c) => c.condition_code), "DISCRIMINATORY_QUESTION", "OUTCOME_MISMATCH"].sort(),
    );
    expect(hansa.conditions.find((c) => c.condition_code === "AGENT_LOOP")?.metric_key).toBe("repetition");
  });

  it("default v2: interruptions and pronunciation are N/A until their data exists", () => {
    expect(unavailableMetrics(caller.metrics, [])).toEqual(["interruptions", "pronunciation_numbers"]);
  });

  it("seeds the PRD §4.5 severities; AGENT_LOOP is Major and zeroes Repetition on v2", () => {
    for (const s of SCORECARDS) {
      for (const c of s.conditions) expect(c.severity).toBe(c.condition_code === "AGENT_LOOP" ? "major" : "critical");
    }
    expect(caller.conditions.find((c) => c.condition_code === "AGENT_LOOP")?.metric_key).toBe("repetition");
    expect(SCORECARDS.find((s) => s.scorecard_id === "hansa")!.conditions.map((c) => c.condition_code)).toContain("OUTCOME_MISMATCH");
  });

  it("copies the code's failure-condition wording word for word", () => {
    for (const f of [...COMMON_FAILURES, ...hansaRubric.failure_conditions]) {
      const seededCondition = FAILURE_CONDITIONS.find((c) => c.code === f.code)!;
      expect({ label: seededCondition.label, definition: seededCondition.definition }).toEqual({
        label: f.label,
        definition: f.definition,
      });
    }
  });

  // Once a rubric's version is bumped these no longer apply: the seed keeps the v3 text the v1 audits were graded on.
  for (const [id, rubric, current] of [
    ["hansa", hansaRubric, hansaRubric.version === "hansa-v3"],
    ["default", defaultRubric, defaultRubric.version === "default-v3"],
  ] as const) {
    it.if(current)(`${id} v1 is ${rubric.version}'s 5 × 20 scorecard and goal, word for word`, () => {
      const template = SCORECARDS.find((s) => s.scorecard_id === id && s.version === 1)!;
      expect(template.metrics.map((m) => [m.key, m.weight])).toEqual(SCORECARD.map((c) => [c.key, 20]));
      for (const m of template.metrics) {
        const category = rubric.categories[m.key as keyof typeof rubric.categories];
        expect({ checks: m.checks, not_applicable_when: m.applicability, anchors: m.anchors }).toEqual(category);
      }
      expect(template.fail_score_cap).toBe(rubric.fail_score_cap);
      expect(template.conditions.map((c) => c.condition_code).sort()).toEqual(
        [...rubric.failure_conditions.map((f) => f.code), "CALL_ERROR", "NO_AGENT_SPEECH"].sort(),
      );

      for (const g of GOAL_CONFIGS.filter((g) => (id === "hansa" ? g.agent_code === "hrms" : g.agent_code !== "hrms"))) {
        expect({
          description: g.description,
          achieved_if: g.success_criteria,
          not_applicable_if: g.not_applicable_when,
          reason_codes: g.reason_codes,
        }).toEqual(rubric.goal);
      }
    });
  }
});

describe("failure-condition library (PRD §4.5, src/audit/v2/conditions.ts)", () => {
  const library = (code: string) => CONDITION_LIBRARY.find((c) => c.code === code);

  it("copies v1's conditions word for word; v1 keeps its own", () => {
    for (const f of [...COMMON_FAILURES, ...hansaRubric.failure_conditions]) {
      expect({ code: f.code, label: library(f.code)?.label, definition: library(f.code)?.definition }).toEqual(f);
    }
  });

  it("is exactly what migrations 0004 and 0010 seed", () => {
    const seeded = [...FAILURE_CONDITIONS, ...PROPOSED_CONDITIONS].map((c) => ({
      code: c.code,
      label: c.label,
      definition: c.definition,
      defaultSeverity: c.default_severity,
      rollsUpTo: c.rolls_up_to,
      detection: c.detection,
    }));
    expect(CONDITION_LIBRARY).toEqual(seeded);
    expect(new Set(CONDITION_LIBRARY.map((c) => c.code)).size).toBe(CONDITION_LIBRARY.length);
  });

  it("seeded severities: the PRD defaults for the existing ones, Minor for every new one", () => {
    const major = ["AGENT_LOOP"];
    for (const c of FAILURE_CONDITIONS) expect([c.code, library(c.code)?.defaultSeverity]).toEqual([c.code, major.includes(c.code) ? "major" : "critical"]);
    for (const c of PROPOSED_CONDITIONS) expect([c.code, library(c.code)?.defaultSeverity]).toEqual([c.code, "minor"]);
    expect(PROPOSED_CONDITIONS.map((c) => c.code)).not.toContain("NO_AGENT_SPEECH");
  });

  it("every new definition says what does not count", () => {
    for (const c of PROPOSED_CONDITIONS) expect(c.definition).toContain("NOT count");
  });

  it("v3 scorecards: v2 plus the new conditions as Minor; three disabled until their data exists; Hansa keeps OUTCOME_MISMATCH only", () => {
    expect(DISABLED_UNTIL_DATA).toEqual(["UNRESPONSIVE_AGENT", "FALSE_ACTION_CLAIM", "SKIPPED_REQUIRED_STEP"]);
    for (const s of V3_SCORECARDS) {
      expect([s.from, s.version]).toEqual([2, 3]);
      for (const c of s.conditions) {
        expect(c).toMatchObject({ severity: "minor", enabled: !DISABLED_UNTIL_DATA.includes(c.condition_code) });
        if (c.metric_key) expect(DEFAULT_V2_KEYS).toContain(c.metric_key);
      }
    }
    const codes = (id: string) => V3_SCORECARDS.find((s) => s.scorecard_id === id)!.conditions.map((c) => c.condition_code);
    expect(codes("default")).toEqual(PROPOSED_CONDITIONS.map((c) => c.code));
    expect(codes("hansa")).toEqual(PROPOSED_CONDITIONS.map((c) => c.code).filter((c) => c !== "OUTCOME_MISRECORDED"));
  });
});

const DEFAULT_V2_KEYS = SCORECARDS.find((s) => s.scorecard_id === "default" && s.version === 2)!.metrics.map((m) => m.key);

import { describe, expect, it } from "bun:test";
import { type GoalFields, type ScorecardFields, describeChange, goalPatch, scorecardPatch } from "../dashboard/src/lib/admin-logic";
import { seededGoal, seededScorecard } from "./audit/v2/seeded-config";

/** The admin editors' client-side logic (`dashboard/src/lib/admin-logic.ts`): what Save draft sends, and change labels. */
const saved = (): ScorecardFields => structuredClone(seededScorecard("default"));

describe("scorecardPatch", () => {
  it("sends nothing when nothing changed", () => {
    expect(scorecardPatch(saved(), saved())).toBeNull();
  });

  it("sends only the changed fields: weights, one rubric example, the threshold", () => {
    const e = saved();
    e.pass_threshold = 45;
    e.metrics[0]!.weight = 18;
    e.metrics[1]!.weight = 2;
    e.metrics[1]!.rubric.anchors["5"] = "Half right";
    expect(scorecardPatch(saved(), e)).toEqual({
      pass_threshold: 45,
      metrics: [
        { key: "flow_adherence", weight: 18 },
        { key: "query_handling", weight: 2, rubric: { anchors: { "5": "Half right" } } },
      ],
    });
  });

  it("sends a changed condition with all its values, and one attached from the library", () => {
    const e = saved();
    e.conditions.find((c) => c.condition_code === "AGENT_LOOP")!.severity = "critical";
    e.conditions.push({ condition_code: "OUTCOME_MISMATCH", enabled: true, severity: "minor", metric_key: null });
    expect(scorecardPatch(saved(), e)?.conditions).toEqual([
      { code: "AGENT_LOOP", enabled: true, severity: "critical", metric_key: "repetition" },
      { code: "OUTCOME_MISMATCH", enabled: true, severity: "minor", metric_key: null },
    ]);
  });

  it("ignores a metric the saved draft doesn't have (metrics can't be added)", () => {
    const e = saved();
    e.metrics.push({ ...e.metrics[0]!, key: "made_up" });
    expect(scorecardPatch(saved(), e)).toBeNull();
  });
});

describe("goalPatch", () => {
  const goal = (): GoalFields => structuredClone(seededGoal("caller"));

  it("sends nothing when nothing changed, and never the silence limit", () => {
    expect(goalPatch(goal(), goal())).toBeNull();
    const e = goal();
    e.system_checks.silence_limit_s = 3;
    expect(goalPatch(goal(), e)).toBeNull();
  });

  it("sends changed fields, reason codes by outcome, and system goal settings", () => {
    const e = goal();
    e.name = "Book a demo";
    e.reason_codes = { ...e.reason_codes, ACHIEVED: ["DEMO_BOOKED"] };
    e.system_checks.flow_steps = ["Greet", "Pitch"];
    expect(goalPatch(goal(), e)).toEqual({
      name: "Book a demo",
      reason_codes: { ACHIEVED: ["DEMO_BOOKED"] },
      system_checks: { flow_steps: ["Greet", "Pitch"] },
    });
  });

  it("clears Partial's codes when its criteria are cleared", () => {
    const withPartial = { ...goal(), partial_success: ["Asked for a callback"], reason_codes: { ...goal().reason_codes, PARTIAL: ["CALLBACK_REQUESTED"] } };
    const cleared = { ...withPartial, partial_success: [] };
    expect(goalPatch(withPartial, cleared)).toEqual({ partial_success: [], reason_codes: { PARTIAL: [] } });
  });
});

describe("describeChange", () => {
  const names = { metrics: { flow_adherence: "Flow adherence" }, conditions: { AGENT_LOOP: "Stuck in a loop", NEW_ONE: "New one" } };
  const label = (field: string, before: unknown, after: unknown) => describeChange({ field, before, after }, names);

  it("names metric, condition, goal and system fields in words", () => {
    expect(label("metric.flow_adherence.weight", 10, 18)).toEqual({ label: "Flow adherence weight", before: "10", after: "18" });
    expect(label("metric.flow_adherence.rubric.anchors.5", "a", "b").label).toBe("Flow adherence 5-point example");
    expect(label("condition.AGENT_LOOP.severity", "major", "critical")).toEqual({ label: "Stuck in a loop severity", before: "Major", after: "Critical" });
    expect(label("condition.AGENT_LOOP.enabled", true, false)).toEqual({ label: "Stuck in a loop on/off", before: "On", after: "Off" });
    expect(label("reason_codes.PARTIAL", [], ["X_Y"])).toEqual({ label: "Partial reason codes", before: "none", after: "X_Y" });
    expect(label("system_checks.silence_limit_s", 8, 10)).toEqual({ label: "Silence limit", before: "8 s", after: "10 s" });
  });

  it("says added or removed for a whole condition or metric", () => {
    expect(label("condition.NEW_ONE", null, { enabled: true, severity: "minor", metric_key: null })).toEqual({
      label: "New one added",
      before: "—",
      after: "Minor",
    });
    expect(label("condition.AGENT_LOOP", { enabled: false, severity: "major", metric_key: "repetition" }, null)).toEqual({
      label: "Stuck in a loop removed",
      before: "Off, Major",
      after: "—",
    });
    expect(label("metric.unknown_key", null, "Thing").label).toBe("unknown_key added");
  });
});

import { describe, expect, it } from "bun:test";
import { DISABLED_UNTIL_DATA } from "@/db/migrations/0010-proposed-conditions.data";
import { NEEDS_DATA } from "./conditions";
import { validateGoalConfig } from "./config";
import { diffGoal, diffScorecard } from "./config-diff";
import { applyGoalEdit, applyScorecardEdit, type ScorecardPatch } from "./config-edit";
import { GOAL_TEMPLATES } from "./goal-templates";
import { seededGoal, seededScorecard } from "./seeded-config";

const draft = () => ({ ...seededScorecard("default"), version: 5, status: "draft" as const });
const edited = (patch: ScorecardPatch) => applyScorecardEdit(draft(), patch);
const errors = (patch: ScorecardPatch) => edited(patch).errors;

describe("applyScorecardEdit", () => {
  it("changes rubric, applicability, auto-fail and the pass threshold, and leaves the draft it was given alone", () => {
    const before = draft();
    const { value } = applyScorecardEdit(before, {
      pass_threshold: 45.5,
      metrics: [
        { key: "query_handling", rubric: { checks: " Answers are correct ", anchors: { 5: "Mostly right" } }, applicability: "No questions asked", auto_fail: true },
      ],
    });
    const m = value!.metrics.find((x) => x.key === "query_handling")!;
    expect([value!.pass_threshold, m.rubric.checks, m.rubric.anchors[5], m.applicability, m.auto_fail]).toEqual([
      45.5,
      "Answers are correct",
      "Mostly right",
      "No questions asked",
      true,
    ]);
    expect(m.rubric.anchors[0]).toBe(before.metrics[1]!.rubric.anchors[0]);
    expect(before.metrics[1]!.auto_fail).toBe(false);
    expect(before.pass_threshold).toBe(40);
  });

  it("takes weights only when they total 100.0", () => {
    const moved = edited({ metrics: [{ key: "flow_adherence", weight: 18 }, ...["query_handling", "troubleshooting", "communication_tone", "opening_closure", "repetition", "stalling_filler", "interruptions", "pronunciation_numbers"].map((key) => ({ key, weight: 9 }))] });
    expect(moved.errors).toEqual([]);
    expect(moved.value!.metrics.map((m) => m.weight)).toEqual([18, 9, 9, 9, 9, 10, 9, 9, 9, 9]);
    expect(errors({ metrics: [{ key: "flow_adherence", weight: 11 }] })).toEqual(["weights total 101, not 100"]);
    expect(errors({ metrics: [{ key: "flow_adherence", weight: 10.05 }] })).toEqual(["flow_adherence has more than one decimal"]);
  });

  it("refuses method, scale, params, unknown metrics and empty rubric text", () => {
    expect(errors({ metrics: [{ key: "repetition", method: "llm" } as never] })).toEqual([
      "repetition: the method can't be changed here; the engine decides how a metric is scored",
    ]);
    expect(errors({ metrics: [{ key: "repetition", scale: 5, params: {} } as never] })).toHaveLength(2);
    expect(errors({ metrics: [{ key: "made_up", name: "x" }] })).toEqual(["no metric made_up on this scorecard (metrics can't be added here)"]);
    expect(errors({ metrics: [{ key: "repetition", name: " ", rubric: { checks: "", anchors: { 10: "" } } }] })).toEqual([
      "repetition: the name can't be empty",
      "repetition: the rubric needs a description of what is checked",
      "repetition: the rubric's 10-point example can't be empty",
    ]);
    expect(errors({ pass_threshold: 101 })).toEqual(["the pass threshold must be 0–100 with at most one decimal"]);
  });

  it("switches conditions on and off and changes severity; Major needs a metric", () => {
    const { value } = edited({
      conditions: [
        { code: "AGENT_LOOP", severity: "critical" },
        { code: "PREMATURE_HANGUP", enabled: false },
        { code: "WRONG_LANGUAGE", severity: "major" },
      ],
    });
    const c = (code: string) => value!.conditions.find((x) => x.condition_code === code)!;
    expect([c("AGENT_LOOP").severity, c("PREMATURE_HANGUP").enabled, c("WRONG_LANGUAGE").severity]).toEqual(["critical", false, "major"]);

    expect(errors({ conditions: [{ code: "PREMATURE_HANGUP", severity: "major" }] })).toEqual([
      "PREMATURE_HANGUP: a Major condition needs the metric it sets to 0",
    ]);
    expect(errors({ conditions: [{ code: "PREMATURE_HANGUP", severity: "major", metric_key: "opening_closure" }] })).toEqual([]);
    expect(errors({ conditions: [{ code: "PREMATURE_HANGUP", metric_key: "nope" }] })).toEqual(["PREMATURE_HANGUP: no metric nope on this scorecard"]);
    expect(errors({ conditions: [{ code: "MADE_UP", enabled: true }] })).toEqual([
      "no condition MADE_UP in the library; add it on the failure conditions page",
    ]);
  });

  it("attaches a library condition the draft doesn't have: on and Minor unless the edit says otherwise", () => {
    const library = ["OUTCOME_MISMATCH", "DISCRIMINATORY_QUESTION", "UNRESPONSIVE_AGENT"];
    // `default` has UNRESPONSIVE_AGENT (off); leave it out so attaching it is tested too.
    const without = () => ({ ...draft(), conditions: draft().conditions.filter((c) => c.condition_code !== "UNRESPONSIVE_AGENT") });
    const attach = (conditions: ScorecardPatch["conditions"]) => applyScorecardEdit(without(), { conditions }, library);
    const added = (r: ReturnType<typeof attach>, code: string) => r.value!.conditions.find((c) => c.condition_code === code);

    expect(added(attach([{ code: "OUTCOME_MISMATCH" }]), "OUTCOME_MISMATCH")).toEqual({
      condition_code: "OUTCOME_MISMATCH",
      enabled: true,
      severity: "minor",
      metric_key: null,
    });
    expect(added(attach([{ code: "DISCRIMINATORY_QUESTION", severity: "critical" }]), "DISCRIMINATORY_QUESTION")?.severity).toBe("critical");
    expect(attach([{ code: "OUTCOME_MISMATCH", severity: "major" }]).errors).toEqual([
      "OUTCOME_MISMATCH: a Major condition needs the metric it sets to 0",
    ]);
    // A condition whose data doesn't exist yet: attached off, and can't be switched on.
    expect(added(attach([{ code: "UNRESPONSIVE_AGENT" }]), "UNRESPONSIVE_AGENT")?.enabled).toBe(false);
    expect(attach([{ code: "UNRESPONSIVE_AGENT", enabled: true }]).errors[0]).toContain("can't be switched on");
    // Without the library list nothing can be attached.
    expect(applyScorecardEdit(draft(), { conditions: [{ code: "OUTCOME_MISMATCH" }] }).errors[0]).toContain("no condition OUTCOME_MISMATCH in the library");
  });

  it("won't switch on a condition whose data doesn't exist yet", () => {
    expect(Object.keys(NEEDS_DATA).sort()).toEqual([...DISABLED_UNTIL_DATA].sort());
    expect(errors({ conditions: [{ code: "UNRESPONSIVE_AGENT", enabled: true }] })).toEqual([
      `UNRESPONSIVE_AGENT can't be switched on: ${NEEDS_DATA.UNRESPONSIVE_AGENT}`,
    ]);
    // Changing its severity while it stays off is fine.
    expect(errors({ conditions: [{ code: "UNRESPONSIVE_AGENT", severity: "critical" }] })).toEqual([]);
  });
});

describe("applyGoalEdit", () => {
  const goal = () => ({ ...seededGoal("caller"), version: 2, status: "draft" as const });

  it("trims lists, drops blank rows, upper-cases reason codes and keeps the silence limit", () => {
    const { value, errors } = applyGoalEdit(goal(), {
      name: " Book a demo ",
      success_criteria: [" Agreed to a demo ", ""],
      partial_success: ["Asked for a callback"],
      required_outputs: ["demo_datetime", " "],
      reason_codes: { ACHIEVED: ["demo_booked"], PARTIAL: ["CALLBACK_REQUESTED"], NOT_APPLICABLE: [] },
      system_checks: { required_variables: ["outcome.contact_channel"], flow_steps: ["Greet", "Pitch", " "] },
    });
    expect(errors).toEqual([]);
    expect(value).toMatchObject({
      name: "Book a demo",
      success_criteria: ["Agreed to a demo"],
      required_outputs: ["demo_datetime"],
      reason_codes: { ACHIEVED: ["DEMO_BOOKED"], PARTIAL: ["CALLBACK_REQUESTED"] },
      system_checks: { silence_limit_s: 8, required_variables: ["outcome.contact_channel"], flow_steps: ["Greet", "Pitch"] },
    });
    expect(value!.reason_codes.NOT_APPLICABLE).toBeUndefined();
    expect(applyGoalEdit(goal(), { system_checks: { flow_steps: [" "] } }).value!.system_checks.flow_steps).toBeNull();
  });

  it("refuses bad codes, bad variable names and duplicates", () => {
    expect(
      applyGoalEdit(goal(), {
        name: "",
        reason_codes: { ACHIEVED: ["ok", "DONE", "DONE"] },
        required_outputs: ["demo time", "a", "a"],
      }).errors,
    ).toEqual([
      "the goal needs a name",
      "required outputs: demo time isn't a variable name (letters, digits, _ and .)",
      "required outputs: a is listed twice",
      "ACHIEVED: reason code OK must be 3–64 capital letters, digits or _",
      "ACHIEVED: reason code DONE is listed twice",
    ]);
    expect(applyGoalEdit(goal(), { system_checks: { silence_limit_s: 3 } as never }).value!.system_checks.silence_limit_s).toBe(8);
  });
});

describe("goal templates", () => {
  it("the seven PRD §3.2 starters, each publishable once applied to a goal", () => {
    expect(GOAL_TEMPLATES.map((t) => t.name)).toEqual([
      "Book a demo",
      "Qualify a lead",
      "Confirm an appointment",
      "Collect a payment commitment",
      "Complete a survey",
      "Verify KYC details",
      "Resolve a support query",
    ]);
    for (const { id: _, ...t } of GOAL_TEMPLATES) {
      const applied = applyGoalEdit(seededGoal("caller"), t);
      expect(applied.errors).toEqual([]);
      expect(validateGoalConfig(applied.value!)).toEqual([]);
    }
  });
});

describe("diffScorecard / diffGoal", () => {
  it("names each changed field, and nothing for an identical copy", () => {
    expect(diffScorecard(seededScorecard("default"), draft())).toEqual([]);
    const after = edited({
      pass_threshold: 50,
      metrics: [
        { key: "flow_adherence", weight: 20, rubric: { anchors: { 5: "Half the steps" } } },
        { key: "repetition", weight: 0 },
      ],
      conditions: [{ code: "AGENT_LOOP", severity: "critical" }],
    }).value!;
    expect(diffScorecard(seededScorecard("default"), after)).toEqual([
      { field: "pass_threshold", before: 40, after: 50 },
      { field: "metric.flow_adherence.rubric.anchors.5", before: seededScorecard("default").metrics[0]!.rubric.anchors[5], after: "Half the steps" },
      { field: "metric.flow_adherence.weight", before: 10, after: 20 },
      { field: "metric.repetition.weight", before: 10, after: 0 },
      { field: "condition.AGENT_LOOP.severity", before: "major", after: "critical" },
    ]);
  });

  it("lists added and removed conditions, and ignores key order in params", () => {
    const before = seededScorecard("default");
    const after = { ...before, conditions: [...before.conditions.slice(1), { condition_code: "NEW_ONE", enabled: true, severity: "minor" as const, metric_key: null }] };
    after.metrics = after.metrics.map((m) => ({ ...m, params: Object.fromEntries(Object.entries(m.params).reverse()) }));
    expect(diffScorecard(before, after)).toEqual([
      { field: "condition.NEW_ONE", before: null, after: { enabled: true, severity: "minor", metric_key: null } },
      { field: "condition.CRITICAL_HALLUCINATION", before: { enabled: true, severity: "critical", metric_key: null }, after: null },
    ]);
  });

  it("goal: business fields, reason codes per outcome and system checks", () => {
    const before = seededGoal("caller");
    const after = applyGoalEdit(before, { name: "Book a demo", reason_codes: { PARTIAL: ["CALLBACK_REQUESTED"] }, system_checks: { flow_steps: ["Greet"] } }).value!;
    expect(diffGoal(before, after)).toEqual([
      { field: "name", before: before.name, after: "Book a demo" },
      { field: "reason_codes.PARTIAL", before: [], after: ["CALLBACK_REQUESTED"] },
      { field: "system_checks.flow_steps", before: null, after: ["Greet"] },
    ]);
  });
});

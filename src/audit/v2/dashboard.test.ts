import { describe, expect, it } from "bun:test";
import { type AuditRow, type CallRow, type DashboardFilters, dashboardSummary, defaultRange, previousRange, shiftDay, trendBucket } from "./dashboard";

const row = (over: Partial<AuditRow> = {}): AuditRow => ({
  day: "2026-11-02",
  agent_code: "caller",
  direction: "outbound",
  scorecard_id: "default",
  scorecard_version: 4,
  goal_version: 1,
  audited: 10,
  sampled: 0,
  passed: 8,
  failed: 2,
  needs_review: 1,
  system_pass: 9,
  system_fail: 1,
  system_na: 0,
  business_achieved: 4,
  business_partial: 2,
  business_not_achieved: 2,
  business_na: 2,
  score_sum: 750,
  scored: 10,
  buckets: { success: 4, business_miss: 3, ai_failure: 1, achieved_despite_ai: 0, na: 2 },
  histogram: [0, 1, 1, 3, 5],
  metric_averages: { repetition: { n: 10, score_sum: 80, max_sum: 100, lost: 4 } },
  failure_codes: { AGENT_LOOP: 2 },
  system_checks: { S1: { pass: 10, fail: 0, na: 0 }, S2: { pass: 9, fail: 1, na: 0 } },
  business_reasons: { PRICE: 2 },
  rs_passed: 6,
  rs_failed: 4,
  rs_score_sum: 700,
  rs_scored: 10,
  rs_histogram: [0, 1, 2, 4, 3],
  ...over,
});

const calls = (over: Partial<CallRow> = {}): CallRow => ({
  day: "2026-11-02",
  agent_code: "caller",
  direction: "outbound",
  total: 40,
  connected: 20,
  not_connected: 15,
  ...over,
});

const filters = (over: Partial<DashboardFilters> = {}): DashboardFilters => ({
  from: "2026-11-01",
  to: "2026-11-03",
  compare: true,
  mode: "as_audited",
  ...over,
});

const lookups = {
  thresholds: { "default@4": 70, "hansa@4": 60 },
  metricLabels: { repetition: "Repetition" },
  conditionLabels: { AGENT_LOOP: "Agent loop" },
  markers: [
    { day: "2026-11-02", agent_code: "caller", type: "prompt", label: "Prompt v12" },
    { day: "2026-11-02", agent_code: "hrms", type: "prompt", label: "Hansa prompt" },
    { day: "2026-10-20", agent_code: null, type: "scorecard", label: "out of range" },
  ],
};

/** The fixture: two agents in range, one row in the previous period, and rows the filters must drop. */
const AUDITS = [
  row(),
  row({ day: "2026-11-03", agent_code: "hrms", direction: "inbound", scorecard_id: "hansa", goal_version: 2, audited: 5, sampled: 5, passed: 2, failed: 3,
    needs_review: 0, system_pass: 3, system_fail: 2, business_achieved: 1, business_partial: 0, business_not_achieved: 3, business_na: 1,
    score_sum: 250, scored: 5, histogram: [1, 1, 1, 1, 1], metric_averages: { repetition: { n: 5, score_sum: 20, max_sum: 50, lost: 5 } },
    failure_codes: { AGENT_LOOP: 1, CALL_ERROR: 2 }, system_checks: { S2: { pass: 3, fail: 2, na: 0 } }, business_reasons: { TIMING: 3 },
    rs_passed: 2, rs_failed: 3, rs_score_sum: 250, rs_scored: 5, rs_histogram: [1, 1, 1, 1, 1],
    buckets: { success: 1, business_miss: 1, ai_failure: 2, achieved_despite_ai: 0, na: 1 } }),
  row({ day: "2026-10-30", audited: 4, passed: 1, failed: 3, rs_passed: 1, rs_failed: 3 }), // previous period
  row({ day: "2026-11-05" }), // after the range
];
const CALLS = [calls(), calls({ day: "2026-11-03", agent_code: "hrms", direction: "inbound", total: 10, connected: 6, not_connected: 4 }), calls({ day: "2026-10-31", total: 30, connected: 10, not_connected: 10 })];

describe("date helpers", () => {
  it("shifts days, gives the default 7 days and the previous period of the same length", () => {
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
    expect(defaultRange("2026-11-06")).toEqual({ from: "2026-10-31", to: "2026-11-06" });
    expect(previousRange("2026-11-01", "2026-11-03")).toEqual({ from: "2026-10-29", to: "2026-10-31" });
  });
  it("buckets a day into its Monday-start week when weekly", () => {
    expect(trendBucket("2026-11-08", true)).toBe("2026-11-02"); // Sunday → Monday before
    expect(trendBucket("2026-11-02", true)).toBe("2026-11-02");
    expect(trendBucket("2026-11-08", false)).toBe("2026-11-08");
  });
});

describe("dashboardSummary", () => {
  it("gives every KPI with its numerator and denominator, and the previous period when comparing", () => {
    const d = dashboardSummary(AUDITS, CALLS, filters(), lookups);
    expect(d.kpis.total_calls.current).toEqual({ num: 50, den: 50, value: 1 });
    expect(d.kpis.connect_rate.current).toEqual({ num: 26, den: 45, value: 26 / 45 });
    expect(d.kpis.audit_coverage.current).toEqual({ num: 15, den: 26, value: 15 / 26 });
    expect(d.kpis.pass_rate.current).toEqual({ num: 10, den: 15, value: 10 / 15 });
    expect(d.kpis.pass_rate.previous).toEqual({ num: 1, den: 4, value: 0.25 });
    expect(d.kpis.system_goal_rate.current).toEqual({ num: 12, den: 15, value: 0.8 });
    // applicable = achieved + partial + not achieved; Partial is its own share
    expect(d.kpis.business_goal_rate.current).toEqual({ num: 5, den: 12, value: 5 / 12 });
    expect(d.kpis.partial_share.current).toEqual({ num: 2, den: 12, value: 2 / 12 });
    expect(d.kpis.average_score.current).toEqual({ num: 1000, den: 15, value: 66.7 });
    expect(d.kpis.connect_rate.previous).toEqual({ num: 10, den: 20, value: 0.5 });
    expect(d.sample).toEqual({ audited: 15, sampled: 5, hand_picked: 10, low: true });
    expect(dashboardSummary(AUDITS, CALLS, filters({ compare: false }), lookups).kpis.pass_rate.previous).toBeNull();
  });

  it("uses the re-scored counts in re-scored mode; goals don't change", () => {
    const d = dashboardSummary(AUDITS, CALLS, filters({ mode: "rescored" }), lookups);
    expect(d.kpis.pass_rate.current).toEqual({ num: 8, den: 15, value: 8 / 15 });
    expect(d.kpis.average_score.current.value).toBe(63.3);
    expect(d.histogram.bins.map((b) => b.calls)).toEqual([1, 2, 3, 5, 4]);
    expect(d.kpis.business_goal_rate.current.num).toBe(5);
  });

  it("filters by agent, direction, goal and scorecard version; call counts follow agent and direction only", () => {
    const d = dashboardSummary(AUDITS, CALLS, filters({ agent: "hrms" }), lookups);
    expect([d.kpis.pass_rate.current.num, d.kpis.total_calls.current.num]).toEqual([2, 10]);
    expect(d.markers.map((m) => m.label)).toEqual(["Hansa prompt"]);
    expect(dashboardSummary(AUDITS, CALLS, filters({ direction: "outbound" }), lookups).sample.audited).toBe(10);
    expect(dashboardSummary(AUDITS, CALLS, filters({ goal: "hrms@2" }), lookups).sample.audited).toBe(5);
    const byVersion = dashboardSummary(AUDITS, CALLS, filters({ scorecard: "default@4" }), lookups);
    expect([byVersion.sample.audited, byVersion.kpis.total_calls.current.num, byVersion.histogram.threshold]).toEqual([10, 50, 70]);
  });

  it("builds the trend per day with versions, the histogram, failures, buckets, heatmap, funnel and agent table", () => {
    const d = dashboardSummary(AUDITS, CALLS, filters(), lookups);
    expect(d.bucket).toBe("day");
    expect(d.trend.map((p) => [p.bucket, p.audited, p.pass_rate.value, p.versions])).toEqual([
      ["2026-11-01", 0, null, []],
      ["2026-11-02", 10, 0.8, ["default@4"]],
      ["2026-11-03", 5, 0.4, ["hansa@4"]],
    ]);
    // two versions with different thresholds: no single line to draw
    expect(d.histogram.threshold).toBeNull();
    expect(d.histogram.bins.map((b) => [b.label, b.calls])).toEqual([
      ["0-20", 1],
      ["20-40", 2],
      ["40-60", 2],
      ["60-80", 4],
      ["80-100", 6],
    ]);
    expect(d.failures.map((x) => [x.kind, x.key, x.calls, x.of])).toEqual([
      ["metric", "repetition", 9, 15],
      ["condition", "AGENT_LOOP", 3, 15], // ties by label
      ["check", "S2", 3, 15],
      ["condition", "CALL_ERROR", 2, 15],
    ]);
    expect(d.buckets.current).toEqual({ success: 5, business_miss: 4, ai_failure: 3, achieved_despite_ai: 0, na: 3 });
    expect(d.heatmap.agents.map((a) => a.code)).toEqual(["hrms", "caller"]);
    expect(d.heatmap.cells).toEqual([[{ n: 5, value: 40 }], [{ n: 10, value: 80 }]]);
    const all = d.funnel[0]!;
    expect(all.stages.map((s) => s.calls)).toEqual([26, 15, 12, 12, 5]);
    expect(all.reasons).toEqual([
      { reason: "TIMING", calls: 3 },
      { reason: "PRICE", calls: 2 },
    ]);
    expect(d.funnel.map((x) => x.label)).toEqual(["All agents", "Hansa (HR)", "Caller"]);
    expect(d.agents.map((a) => [a.code, a.total_calls, a.audited, a.pass_rate.num, a.spark])).toEqual([
      ["hrms", 10, 5, 2, [null, null, 0.4]],
      ["caller", 40, 10, 8, [null, 0.8, null]],
    ]);
    expect(d.agents[1]!.previous_pass_rate).toEqual({ num: 1, den: 4, value: 0.25 });
  });

  it("goes weekly past 60 days and is all nulls with no data", () => {
    const d = dashboardSummary([], [], filters({ from: "2026-08-01", to: "2026-11-01" }), lookups);
    expect(d.bucket).toBe("week");
    expect(d.trend[0]!.bucket).toBe("2026-07-27");
    expect(d.kpis.pass_rate.current).toEqual({ num: 0, den: 0, value: null });
    expect(d.kpis.average_score.current.value).toBeNull();
    expect(d.failures).toEqual([]);
    expect(d.funnel).toHaveLength(1);
    expect(d.sample.low).toBe(true);
  });
});

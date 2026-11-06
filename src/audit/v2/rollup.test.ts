import { describe, expect, it } from "bun:test";
import {
  type RollupAudit,
  buildAuditRollups,
  buildCallRollups,
  daysBetween,
  histogramBin,
  istDay,
  istDayRange,
  msUntilIstHour,
  outcomeBucket,
  rollupRates,
} from "./rollup";

const audit = (over: Partial<RollupAudit> = {}): RollupAudit => ({
  call_created_at: new Date("2026-11-02T06:00:00Z"),
  agent_code: "caller",
  agent_id: 9,
  scorecard_id: "default",
  scorecard_version: 2,
  score: 70,
  success_result: "PASS",
  system_goal: "PASS",
  business_goal: "ACHIEVED",
  failure_codes: [],
  needs_review: false,
  metrics: [],
  ...over,
});

describe("istDay / istDayRange", () => {
  it("puts 18:29 UTC on the same IST day and 18:30 UTC on the next", () => {
    expect(istDay(new Date("2026-11-02T18:29:59Z"))).toBe("2026-11-02");
    expect(istDay(new Date("2026-11-02T18:30:00Z"))).toBe("2026-11-03");
  });
  it("gives an IST day as a half-open UTC range", () => {
    expect(istDayRange("2026-11-03")).toEqual({ from: new Date("2026-11-02T18:30:00Z"), to: new Date("2026-11-03T18:30:00Z") });
    expect(() => istDayRange("2026-02-30")).toThrow();
    expect(() => istDayRange("3 Nov")).toThrow();
  });
  it("lists the days of a range, both ends included", () => {
    expect(daysBetween("2026-10-30", "2026-11-02")).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
    expect(daysBetween("2026-11-02", "2026-11-02")).toEqual(["2026-11-02"]);
    expect(daysBetween("2026-11-03", "2026-11-02")).toEqual([]);
  });
});

describe("histogramBin", () => {
  it("uses [0,20) … [80,100] with 100 in the last bin", () => {
    expect([0, 19.9, 20, 39.9, 40, 60, 79.9, 80, 99.9, 100].map(histogramBin)).toEqual([0, 0, 1, 1, 2, 3, 3, 4, 4, 4]);
  });
});

describe("outcomeBucket", () => {
  it("places system × business, with PARTIAL as not achieved and N/A or missing as na", () => {
    expect(outcomeBucket("PASS", "ACHIEVED")).toBe("success");
    expect(outcomeBucket("PASS", "NOT_ACHIEVED")).toBe("business_miss");
    expect(outcomeBucket("PASS", "PARTIAL")).toBe("business_miss");
    expect(outcomeBucket("FAIL", "NOT_ACHIEVED")).toBe("ai_failure");
    expect(outcomeBucket("FAIL", "PARTIAL")).toBe("ai_failure");
    expect(outcomeBucket("FAIL", "ACHIEVED")).toBe("achieved_despite_ai");
    expect(outcomeBucket("NOT_APPLICABLE", "ACHIEVED")).toBe("na");
    expect(outcomeBucket("PASS", "NOT_APPLICABLE")).toBe("na");
    expect(outcomeBucket("PASS", null)).toBe("na");
    expect(outcomeBucket(null, "ACHIEVED")).toBe("na");
  });
});

describe("buildAuditRollups", () => {
  it("groups by IST day, agent and scorecard version and counts every field", () => {
    const rows = buildAuditRollups([
      audit({ score: 100, failure_codes: ["AGENT_LOOP", "AGENT_LOOP"], metrics: [{ key: "repetition", score: 4, max: 10, n_a: false }] }),
      audit({
        agent_code: null, // resolved from agent_id 9
        score: 35.5,
        success_result: "FAIL",
        system_goal: "FAIL",
        business_goal: "PARTIAL",
        needs_review: true,
        failure_codes: ["AGENT_LOOP"],
        metrics: [
          { key: "repetition", score: 8, max: 10, n_a: false },
          { key: "troubleshooting", score: null, max: 10, n_a: true },
        ],
      }),
      audit({ score: null, success_result: null, system_goal: "NOT_APPLICABLE", business_goal: null }),
      audit({ call_created_at: new Date("2026-11-02T18:30:00Z") }), // next IST day
      audit({ scorecard_version: 1 }),
      audit({ agent_code: null, agent_id: 77 }), // no such agent
    ]);
    expect(rows.map((r) => [r.day, r.agent_code, r.scorecard_version, r.audited])).toEqual([
      ["2026-11-02", "caller", 1, 1],
      ["2026-11-02", "caller", 2, 3],
      ["2026-11-02", "unknown", 2, 1],
      ["2026-11-03", "caller", 2, 1],
    ]);
    const r = rows[1]!;
    expect(r).toMatchObject({
      passed: 1,
      failed: 1,
      needs_review: 1,
      system_pass: 1,
      system_fail: 1,
      system_na: 1,
      business_achieved: 1,
      business_partial: 1,
      business_not_achieved: 0,
      business_na: 1,
      score_sum: 135.5,
      scored: 2,
      histogram: [0, 1, 0, 0, 1],
      buckets: { success: 1, business_miss: 0, ai_failure: 1, achieved_despite_ai: 0, na: 1 },
      metric_averages: { repetition: { n: 2, score_sum: 12, max_sum: 20 } },
      failure_codes: { AGENT_LOOP: 2 },
    });
  });
});

describe("buildCallRollups", () => {
  it("counts completed as connected, no_answer + failed as not connected, the rest only in total", () => {
    expect(
      buildCallRollups([
        { day: "2026-11-02", agent_code: null, agent_id: 9, status: "completed", n: 5 },
        { day: "2026-11-02", agent_code: "caller", agent_id: null, status: "no_answer", n: 3 },
        { day: "2026-11-02", agent_code: null, agent_id: 9, status: "failed", n: 1 },
        { day: "2026-11-02", agent_code: null, agent_id: 9, status: "queued", n: 2 },
        { day: "2026-11-02", agent_code: null, agent_id: 1, status: null, n: 1 },
      ]),
    ).toEqual([
      { day: "2026-11-02", agent_code: "caller", total: 11, connected: 5, not_connected: 4 },
      { day: "2026-11-02", agent_code: "hrms", total: 1, connected: 0, not_connected: 0 },
    ]);
  });
});

describe("rollupRates", () => {
  it("uses applicable calls only, keeps Partial apart, and is null with nothing behind it", () => {
    const counts = {
      passed: 3,
      failed: 1,
      system_pass: 2,
      system_fail: 2,
      business_achieved: 1,
      business_partial: 1,
      business_not_achieved: 2,
      score_sum: 200,
      scored: 3,
    };
    expect(rollupRates(counts, { connected: 6, not_connected: 2 })).toEqual({
      pass_rate: 0.75,
      system_goal_rate: 0.5,
      business_goal_rate: 0.25,
      partial_share: 0.25,
      average_score: 66.7,
      connect_rate: 0.75,
    });
    const none = Object.fromEntries(Object.keys(counts).map((k) => [k, 0])) as typeof counts;
    expect(rollupRates(none, { connected: 0, not_connected: 0 })).toEqual({
      pass_rate: null,
      system_goal_rate: null,
      business_goal_rate: null,
      partial_share: null,
      average_score: null,
      connect_rate: null,
    });
  });
});

describe("msUntilIstHour", () => {
  it("waits for the next 02:00 IST, tomorrow once it has passed", () => {
    // 01:00 IST = 19:30 UTC the day before
    expect(msUntilIstHour(new Date("2026-11-02T19:30:00Z"), 2)).toBe(3_600_000);
    // exactly 02:00 IST → the next day
    expect(msUntilIstHour(new Date("2026-11-02T20:30:00Z"), 2)).toBe(86_400_000);
    // 03:00 IST → 23 h
    expect(msUntilIstHour(new Date("2026-11-02T21:30:00Z"), 2)).toBe(23 * 3_600_000);
  });
});

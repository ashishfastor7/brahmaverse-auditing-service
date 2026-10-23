import { describe, expect, it } from "bun:test";
import type { Metric } from "./config";
import { type MetricResult, computeScore, passes, weightedScore } from "./score";

const metric = (key: string, auto_fail = false) => ({ key, auto_fail }) as Pick<Metric, "key" | "auto_fail">;
const scorecard = (auto_fail: string[] = [], pass_threshold = 40) => ({
  pass_threshold,
  metrics: ["a", "b", "c", "d"].map((k) => metric(k, auto_fail.includes(k))),
});
const scored = (key: string, score: number, max = 10): MetricResult => ({ key, score, max, n_a: false });
const na = (key: string): MetricResult => ({ key, score: null, max: 10, n_a: true });
const even = { a: 25, b: 25, c: 25, d: 25 };

describe("computeScore (PRD §4.2)", () => {
  it("all applicable: 100 × Σ w·s/m ÷ Σ w", () => {
    // 40·1 + 30·0.5 + 20·0.8 + 10·0.6 = 77
    const results = [scored("a", 10), scored("b", 5), scored("c", 8), scored("d", 6)];
    expect(computeScore(results, { a: 40, b: 30, c: 20, d: 10 }, scorecard())).toEqual({ score: 77, passed: true, failedBy: [] });
  });

  it("each metric is normalised by its own maximum", () => {
    expect(computeScore([scored("a", 3, 5), scored("b", 15, 20)], { a: 50, b: 50 }, scorecard()).score).toBe(67.5);
  });

  it("N/A metrics drop out and the remaining weights are re-normalised", () => {
    const results = [scored("a", 10), scored("b", 5), na("c"), na("d")];
    expect(computeScore(results, { a: 30, b: 10, c: 40, d: 20 }, scorecard()).score).toBe(87.5);
  });

  it("weight 0 (or no weight) drops a metric out, and its 0 doesn't auto-fail the call", () => {
    const results = [scored("a", 8), scored("b", 4), scored("c", 0)];
    expect(computeScore(results, { a: 50, b: 50, c: 0 }, scorecard(["c"]))).toEqual({ score: 60, passed: true, failedBy: [] });
    expect(computeScore(results, { a: 50, b: 50 }, scorecard(["c"]))).toEqual({ score: 60, passed: true, failedBy: [] });
  });

  it("all N/A: no score, and the call fails", () => {
    expect(computeScore([na("a"), na("b")], even, scorecard())).toEqual({ score: null, passed: false, failedBy: [{ kind: "no_score" }] });
  });

  it("rounds to one decimal and checks the threshold on the rounded score", () => {
    // 39.999 is shown as 40.0, so it passes; 39.9 fails.
    const at40 = computeScore([scored("a", 3.9996), scored("b", 4), scored("c", 4), scored("d", 4)], even, scorecard());
    expect(at40).toEqual({ score: 40, passed: true, failedBy: [] });
    const at399 = computeScore([scored("a", 3.96), scored("b", 4), scored("c", 4), scored("d", 4)], even, scorecard());
    expect(at399).toEqual({ score: 39.9, passed: false, failedBy: [{ kind: "below_threshold" }] });
  });

  it("exactly at the threshold passes", () => {
    const results = [scored("a", 4), scored("b", 4), scored("c", 4), scored("d", 4)];
    expect(computeScore(results, even, scorecard())).toEqual({ score: 40, passed: true, failedBy: [] });
  });

  it("a metric that isn't N/A but has no score (nothing came back for it) drops out like N/A", () => {
    const results = [scored("a", 10), { key: "b", score: null, max: 10, n_a: false }];
    expect(weightedScore(results, { a: 50, b: 50 })).toBe(100);
  });

  it("a clean call with no failure condition that scores 35 fails", () => {
    const results = [scored("a", 3.5), scored("b", 3.5), scored("c", 3.5), scored("d", 3.5)];
    expect(computeScore(results, even, scorecard())).toEqual({ score: 35, passed: false, failedBy: [{ kind: "below_threshold" }] });
  });

  it("uses the scorecard's threshold", () => {
    const results = [scored("a", 5), scored("b", 5), scored("c", 5), scored("d", 5)];
    expect(computeScore(results, even, scorecard([], 60)).passed).toBe(false);
    expect(computeScore(results, even, scorecard([], 50)).passed).toBe(true);
  });

  it("an auto-fail metric at 0 fails a call that scores 75", () => {
    const results = [scored("a", 0), scored("b", 10), scored("c", 10), scored("d", 10)];
    expect(computeScore(results, even, scorecard(["a"]))).toEqual({
      score: 75,
      passed: false,
      failedBy: [{ kind: "auto_fail", metric: "a" }],
    });
    // Not auto-fail, or auto-fail but N/A: passes.
    expect(computeScore(results, even, scorecard()).passed).toBe(true);
    expect(computeScore([na("a"), scored("b", 10)], even, scorecard(["a"])).passed).toBe(true);
  });

  it("a Critical failure flag fails a call that scores 90", () => {
    const results = [scored("a", 9), scored("b", 9), scored("c", 9), scored("d", 9)];
    expect(computeScore(results, even, scorecard(), ["CRITICAL_HALLUCINATION"])).toEqual({
      score: 90,
      passed: false,
      failedBy: [{ kind: "critical", code: "CRITICAL_HALLUCINATION" }],
    });
  });

  it("lists every reason a call failed", () => {
    const results = [scored("a", 0), scored("b", 2), scored("c", 0), scored("d", 2)];
    expect(computeScore(results, even, scorecard(["a", "c"]), ["IGNORED_STOP_REQUEST", "CALL_ERROR"]).failedBy).toEqual([
      { kind: "below_threshold" },
      { kind: "auto_fail", metric: "a" },
      { kind: "auto_fail", metric: "c" },
      { kind: "critical", code: "IGNORED_STOP_REQUEST" },
      { kind: "critical", code: "CALL_ERROR" },
    ]);
  });

  it("weightedScore and passes on their own (P0-6)", () => {
    expect(weightedScore([scored("a", 10), na("b")], { a: 10, b: 90 })).toBe(100);
    expect(weightedScore([na("a")], { a: 100 })).toBeNull();
    expect(passes(40, 40, false, false)).toBe(true);
    expect(passes(39.9, 40, false, false)).toBe(false);
    expect(passes(95, 40, true, false)).toBe(false);
    expect(passes(95, 40, false, true)).toBe(false);
    expect(passes(null, 40, false, false)).toBe(false);
  });
});

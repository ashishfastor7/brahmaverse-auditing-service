import { describe, expect, it } from "bun:test";
import { applyScorecardEdit, type ScorecardPatch } from "./config-edit";
import type { MetricResult } from "./score";
import { seededScorecard } from "./seeded-config";
import { type StoredAudit, simulateScorecard } from "./simulate";

const published = seededScorecard("default");
const draft = (patch: ScorecardPatch) => {
  const { value, errors } = applyScorecardEdit({ ...published, version: 5 }, patch);
  if (!value) throw new Error(errors.join("; "));
  return value;
};

/** Scores out of 10 per metric key; keys left out are N/A (interruptions and pronunciation always are). */
const audit = (id: number, scores: Record<string, number | null>, flags: StoredAudit["flags"] = []): StoredAudit => ({
  id,
  call_id: 1000 + id,
  flags,
  results: published.metrics.map(
    (m): MetricResult => ({ key: m.key, score: scores[m.key] ?? null, max: 10, n_a: scores[m.key] === undefined || scores[m.key] === null }),
  ),
});
const all = (score: number, over: Record<string, number | null> = {}) =>
  Object.fromEntries([...published.metrics.slice(0, 8).map((m) => [m.key, score] as const), ...Object.entries(over)]);

/** Moves weight from the other metrics onto flow adherence, keeping the total at 100. */
const flowAt = (w: number) =>
  draft({
    metrics: published.metrics.map((m) => ({ key: m.key, weight: m.key === "flow_adherence" ? w : m.key === "query_handling" ? 20 - w : 10 })),
  });

describe("simulateScorecard (P1-20)", () => {
  it("the published version against an unchanged draft changes nothing", () => {
    const audits = [audit(1, all(8)), audit(2, all(3)), audit(3, all(5))];
    const sim = simulateScorecard(audits, published, draft({}));
    expect(sim.before).toEqual({ version: 4, passed: 2, pass_rate: 66.7, average_score: 53.3 });
    expect({ ...sim.after, version: 4 }).toEqual(sim.before);
    expect([sim.flipped, sim.score_changed, sim.unscored]).toEqual([[], 0, { audits: 0, metrics: [] }]);
  });

  it("a weight change flips a borderline call, newly failing ones first", () => {
    // 35.0 today; with flow adherence (10/10) at 20 and query handling (0/10) at 0 it becomes 47.5 and passes.
    const borderline = audit(1, all(3, { flow_adherence: 10, query_handling: 0 }));
    // 50.0 today on a strong query handling score; moving its weight onto a flow adherence of 0 takes it to 37.5.
    const weakFlow = audit(2, all(5, { flow_adherence: 0, query_handling: 10 }));
    const sim = simulateScorecard([borderline, weakFlow], published, flowAt(20));
    expect(sim.flipped.map((f) => [f.audit_id, f.before, f.after])).toEqual([
      [2, { score: 50, passed: true }, { score: 37.5, passed: false }],
      [1, { score: 35, passed: false }, { score: 47.5, passed: true }],
    ]);
    expect([sim.before.passed, sim.after.passed, sim.score_changed]).toEqual([1, 1, 2]);
  });

  it("a severity change from Critical to Minor un-fails a flagged call; Major zeroes its metric", () => {
    const flagged = audit(1, all(8), [{ code: "UNAUTHORIZED_PROMISE", source: "judge", evidence: [{ turns: [3] }] }]);
    const minor = simulateScorecard([flagged], published, draft({ conditions: [{ code: "UNAUTHORIZED_PROMISE", severity: "minor" }] }));
    expect(minor.flipped).toEqual([{ audit_id: 1, call_id: 1001, before: { score: 80, passed: false }, after: { score: 80, passed: true } }]);

    const major = simulateScorecard(
      [flagged],
      published,
      draft({ conditions: [{ code: "UNAUTHORIZED_PROMISE", severity: "major", metric_key: "query_handling" }] }),
    );
    expect(major.flipped[0]!.after).toEqual({ score: 70, passed: true });
  });

  it("a raised threshold and an auto-fail metric fail calls that pass today", () => {
    const sim = simulateScorecard(
      [audit(1, all(5)), audit(2, all(9, { repetition: 0 }))],
      published,
      draft({ pass_threshold: 60, metrics: [{ key: "repetition", auto_fail: true }] }),
    );
    expect(sim.flipped.map((f) => f.audit_id)).toEqual([1, 2]);
    expect(sim.after).toMatchObject({ passed: 0, pass_rate: 0 });
  });

  it("counts audits that never scored a metric the draft weights, and leaves it out of their score", () => {
    const skipped: StoredAudit = { ...audit(1, all(6)), results: audit(1, all(6)).results.filter((r) => r.key !== "repetition") };
    const sim = simulateScorecard([skipped, audit(2, all(6))], published, flowAt(15));
    expect(sim.unscored).toEqual({ audits: 1, metrics: ["repetition"] });
    expect(sim.flipped).toEqual([]);
  });

  it("an all-N/A audit fails on both sides; no audits gives no rates", () => {
    const sim = simulateScorecard([audit(1, {})], published, flowAt(20));
    expect([sim.before, sim.after]).toEqual([
      { version: 4, passed: 0, pass_rate: 0, average_score: null },
      { version: 5, passed: 0, pass_rate: 0, average_score: null },
    ]);
    expect(simulateScorecard([], published, flowAt(20)).before).toEqual({ version: 4, passed: 0, pass_rate: null, average_score: null });
  });
});

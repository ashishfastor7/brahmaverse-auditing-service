import { describe, expect, it } from "bun:test";
import { agentPrompt, cases, plantedRow } from "../../../fixtures/planted/cases";
import { SCORECARDS } from "@/db/migrations/0004-config-seed.data";
import { type Judge, auditCall } from "../audit-call";
import { fixtureJudge, listJudgeFixtures, loadJudgeFixture } from "../judge/fixture-judge";
import { normalizeCall } from "../normalize";
import { hansaRubric } from "../rubrics/hansa";
import type { AuditResult } from "../types";
import { computeScore } from "./score";

/**
 * P1-1: the planted cases give the same pass/fail under v2 scoring as under v1, graded on the v1 template they were
 * recorded against (`hansa` v1, 5 × 20, PRD §4.5 seeded severities). Only two differences are expected:
 * - a loop-only call: `AGENT_LOOP` is Major in v2 (zeroes its metric; on the template it has none), so it no longer
 *   fails on its own;
 * - a clean call under 40: v2 fails it on the threshold, v1 passed it.
 */
const template = SCORECARDS.find((s) => s.scorecard_id === "hansa" && s.version === 1)!;
const scorecard = {
  pass_threshold: template.pass_threshold,
  metrics: template.metrics.map((m) => ({ key: m.key, auto_fail: false })),
  conditions: template.conditions.map((c) => ({ ...c, enabled: true })),
};
const weights = Object.fromEntries(template.metrics.map((m) => [m.key, m.weight]));

/** The v2 verdict on a v1 result: its category points as metric results, its failure reasons as flags. */
function v2Verdict(result: AuditResult) {
  const metrics = Object.entries(result.metrics).map(([key, m]) => ({ key, score: m.score, max: m.max, n_a: !m.applicable }));
  const flags = result.call_success.failure_reasons.map((f) => ({
    code: f.code,
    source: f.source === "rule" ? ("rule" as const) : ("judge" as const),
    evidence: f.evidence,
  }));
  return computeScore(metrics, weights, scorecard, flags);
}

const audit = (caseName: string, judge: Judge) =>
  auditCall(normalizeCall(plantedRow(cases.find((c) => c.name === caseName)!, 900000), {}), {
    judge,
    rubric: hansaRubric,
    agentPrompt,
    agentLabel: "Hansa (HR)",
    reviewThreshold: 0.7,
  }).then((r) => r.result);

describe("planted cases: v2 pass/fail matches v1 except the listed differences (P1-1)", () => {
  for (const name of listJudgeFixtures()) {
    it(`${name}: same verdict as v1`, async () => {
      const fixture = loadJudgeFixture(name);
      const result = await audit(fixture.case, fixtureJudge(name));
      const v2 = v2Verdict(result);
      expect(v2.passed).toBe(result.call_success.result === "PASS");
      expect(v2.flags.dropped).toEqual([]);
    });
  }

  // Calls with no recorded judge run: a stub judge that reports nothing, so only the rules and the scores decide.
  const stub = (score: number): Judge => {
    const output = structuredClone(loadJudgeFixture("hansa-good-call").response.output) as any;
    output.failures = [];
    for (const s of output.scorecard) Object.assign(s, { applicable: true, score });
    return async () => ({ output, model: "stub", usage: { input_tokens: 1, output_tokens: 1 } });
  };

  it("difference: a loop-only call fails in v1 and passes in v2 (AGENT_LOOP is Major)", async () => {
    const result = await audit("agent-loop", stub(8));
    expect(result.call_success.failure_reasons.map((f) => [f.code, f.source])).toEqual([["AGENT_LOOP", "rule"]]);
    expect(result.call_success.result).toBe("FAIL");
    expect(v2Verdict(result)).toMatchObject({
      score: 80,
      passed: true,
      flags: { major: [{ code: "AGENT_LOOP", metric: null }], critical: [] },
    });
  });

  it("difference: a clean call scoring 30 passes in v1 and fails in v2 (under the threshold)", async () => {
    const result = await audit("good-call", stub(3));
    expect(result.call_success.result).toBe("PASS");
    expect(v2Verdict(result)).toMatchObject({ score: 30, passed: false, failedBy: [{ kind: "below_threshold" }] });
  });
});

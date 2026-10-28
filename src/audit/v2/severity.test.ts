import { describe, expect, it } from "bun:test";
import type { ScorecardCondition } from "./config";
import type { MetricResult } from "./score";
import { type Flag, applySeverity } from "./severity";

const condition = (condition_code: string, severity: ScorecardCondition["severity"], metric_key: string | null = null, enabled = true) => ({
  condition_code,
  enabled,
  severity,
  metric_key,
});
const conditions = [
  condition("CRITICAL_HALLUCINATION", "critical"),
  condition("CALL_ERROR", "critical"),
  condition("AGENT_LOOP", "major", "repetition"),
  condition("PREMATURE_HANGUP", "major"),
  condition("WRONG_LANGUAGE", "minor", "language_match"),
  condition("FALSE_ACTION_CLAIM", "minor", null, false),
];
const judge = (code: string, evidence: unknown[] = [{ turns: [3] }]): Flag => ({ code, source: "judge", evidence });
const rule = (code: string, evidence: unknown[] = []): Flag => ({ code, source: "rule", evidence });
const results: MetricResult[] = [
  { key: "repetition", score: 7, max: 10, n_a: false },
  { key: "language_match", score: 6, max: 10, n_a: false },
];

describe("applySeverity (P0-8, PRD §4.5)", () => {
  it("Critical: returned for computeScore to fail the call; no metric changes", () => {
    expect(applySeverity([judge("CRITICAL_HALLUCINATION")], conditions, results)).toEqual({
      critical: ["CRITICAL_HALLUCINATION"],
      major: [],
      minor: [],
      dropped: [],
      results,
    });
  });

  it("Major: sets the linked metric to 0", () => {
    expect(applySeverity([judge("AGENT_LOOP")], conditions, results)).toEqual({
      critical: [],
      major: [{ code: "AGENT_LOOP", metric: "repetition" }],
      minor: [],
      dropped: [],
      results: [{ ...results[0]!, score: 0 }, results[1]!],
    });
  });

  it("Major: a linked metric the judge returned no score for (not N/A) is set to 0 too", () => {
    const unscored = [{ key: "repetition", score: null, max: 10, n_a: false }];
    expect(applySeverity([judge("AGENT_LOOP")], conditions, unscored).results).toEqual([{ ...unscored[0]!, score: 0 }]);
  });

  it("Major: an N/A linked metric stays N/A; with no linked metric it is counted only", () => {
    const na = [{ key: "repetition", score: null, max: 10, n_a: true }];
    expect(applySeverity([judge("AGENT_LOOP")], conditions, na).results).toEqual(na);
    expect(applySeverity([judge("PREMATURE_HANGUP")], conditions, results)).toMatchObject({
      major: [{ code: "PREMATURE_HANGUP", metric: null }],
      results,
    });
  });

  it("Minor: counted, with no score effect even when it links a metric", () => {
    expect(applySeverity([judge("WRONG_LANGUAGE")], conditions, results)).toEqual({
      critical: [],
      major: [],
      minor: ["WRONG_LANGUAGE"],
      dropped: [],
      results,
    });
  });

  it("drops a judge flag without evidence; a rule flag needs none", () => {
    expect(applySeverity([judge("CRITICAL_HALLUCINATION", []), judge("AGENT_LOOP", [])], conditions, results)).toEqual({
      critical: [],
      major: [],
      minor: [],
      dropped: [
        { code: "CRITICAL_HALLUCINATION", reason: "no_evidence" },
        { code: "AGENT_LOOP", reason: "no_evidence" },
      ],
      results,
    });
    expect(applySeverity([rule("CALL_ERROR")], conditions, results).critical).toEqual(["CALL_ERROR"]);
  });

  it("drops a code the scorecard doesn't have and a disabled condition", () => {
    expect(applySeverity([judge("MADE_UP"), judge("FALSE_ACTION_CLAIM")], conditions, results)).toEqual({
      critical: [],
      major: [],
      minor: [],
      dropped: [
        { code: "MADE_UP", reason: "not_on_scorecard" },
        { code: "FALSE_ACTION_CLAIM", reason: "disabled" },
      ],
      results,
    });
  });

  it("a rule flag is dropped like a judge flag when its condition is disabled or not on the scorecard", () => {
    expect(applySeverity([rule("FALSE_ACTION_CLAIM"), judge("FALSE_ACTION_CLAIM"), rule("NO_AGENT_SPEECH")], conditions, results)).toEqual({
      critical: [],
      major: [],
      minor: [],
      dropped: [
        { code: "FALSE_ACTION_CLAIM", reason: "disabled" },
        { code: "NO_AGENT_SPEECH", reason: "not_on_scorecard" },
      ],
      results,
    });
  });

  it("counts each code once; a rule hit wins over the judge's flag for the same code", () => {
    const loopRule = rule("AGENT_LOOP", [{ turn: 3 }, { turn: 5 }, { turn: 7 }]);
    const out = applySeverity([judge("AGENT_LOOP"), loopRule, judge("CRITICAL_HALLUCINATION"), judge("CRITICAL_HALLUCINATION")], conditions, results);
    expect([out.major, out.critical, out.dropped]).toEqual([[{ code: "AGENT_LOOP", metric: "repetition" }], ["CRITICAL_HALLUCINATION"], []]);
    // A judge flag dropped for no evidence doesn't hide a later one that has evidence.
    expect(applySeverity([judge("AGENT_LOOP", []), judge("AGENT_LOOP")], conditions, results)).toMatchObject({
      major: [{ code: "AGENT_LOOP", metric: "repetition" }],
      dropped: [{ code: "AGENT_LOOP", reason: "no_evidence" }],
    });
  });
});

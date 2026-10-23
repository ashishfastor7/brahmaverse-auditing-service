import { describe, expect, it } from "bun:test";
import { applyStoredFlags } from "./rescore";

const conditions = [
  { condition_code: "AGENT_LOOP", metric_key: "repetition" },
  { condition_code: "CALL_ERROR", metric_key: null },
];
const results = [
  { key: "repetition", score: 7, max: 10, n_a: false },
  { key: "query_handling", score: 6, max: 10, n_a: false },
];

describe("applyStoredFlags (re-score inputs)", () => {
  it("a Major flag zeroes its linked metric; Critical codes are returned in order; Minor changes nothing", () => {
    const flags = [
      { condition_code: "AGENT_LOOP", severity: "major" },
      { condition_code: "IGNORED_STOP_REQUEST", severity: "critical" },
      { condition_code: "UNPROFESSIONAL_CONDUCT", severity: "minor" },
      { condition_code: "CALL_ERROR", severity: "critical" },
    ];
    expect(applyStoredFlags(results, flags, conditions)).toEqual({
      results: [
        { key: "repetition", score: 0, max: 10, n_a: false },
        { key: "query_handling", score: 6, max: 10, n_a: false },
      ],
      critical: ["IGNORED_STOP_REQUEST", "CALL_ERROR"],
    });
  });

  it("a Major flag with no linked metric, or for a condition the scorecard doesn't have, zeroes nothing", () => {
    const flags = [
      { condition_code: "CALL_ERROR", severity: "major" },
      { condition_code: "NOT_ON_THIS_SCORECARD", severity: "major" },
    ];
    expect(applyStoredFlags(results, flags, conditions)).toEqual({ results, critical: [] });
  });

  it("an N/A metric stays N/A when its Major flag fires", () => {
    const na = [{ key: "repetition", score: null, max: 10, n_a: true }];
    expect(applyStoredFlags(na, [{ condition_code: "AGENT_LOOP", severity: "major" }], conditions).results).toEqual(na);
  });
});

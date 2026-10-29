import { describe, expect, it } from "bun:test";
import { cases, plantedAgent } from "../../../fixtures/planted/cases";
import { seededDefinitions, seededScorecard } from "./seeded-config";

/**
 * P1-12 / P1-19: every enabled, text-detectable failure condition (judged by the LLM from the transcript) has a planted
 * case on an agent whose scorecard enables it, so `bun run eval:v2` checks the judge catches it. Rule conditions
 * (CALL_ERROR, NO_AGENT_SPEECH) are tested in the rule code; disabled ones wait for their data (P3-5).
 */
describe("planted coverage", () => {
  it("every enabled LLM condition on hansa v4 or default v4 is planted on a scorecard that enables it", () => {
    const llm = new Set(
      seededDefinitions()
        .filter((d) => d.detection === "llm")
        .map((d) => d.code),
    );
    const enabledOn = (id: "hansa" | "default") =>
      new Set(
        seededScorecard(id)
          .conditions.filter((c) => c.enabled && llm.has(c.condition_code))
          .map((c) => c.condition_code),
      );
    const enabled = { hansa: enabledOn("hansa"), default: enabledOn("default") };
    const covered = new Set(
      cases.flatMap((c) => (c.expect.failure_codes ?? []).filter((code) => enabled[plantedAgent(c).scorecard_id].has(code))),
    );
    const all = [...new Set([...enabled.hansa, ...enabled.default])].sort();
    expect(all.length).toBe(15);
    expect(all.filter((code) => !covered.has(code))).toEqual([]);
  });

  it("names are unique, and Caller cases are v2-only (v1's planted eval grades on the Hansa rubric)", () => {
    expect(new Set(cases.map((c) => c.name)).size).toBe(cases.length);
    expect(cases.filter((c) => c.agent === "caller").every((c) => c.v2_only)).toBe(true);
  });
});

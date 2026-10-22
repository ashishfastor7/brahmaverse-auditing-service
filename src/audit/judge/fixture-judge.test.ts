import { describe, expect, it } from "bun:test";
import { cases, agentPrompt, plantedMisses, plantedRow } from "../../../fixtures/planted/cases";
import { auditCall } from "../audit-call";
import { normalizeCall } from "../normalize";
import { hansaRubric } from "../rubrics/hansa";
import { fixtureJudge, listJudgeFixtures, loadJudgeFixture } from "./fixture-judge";

describe("fixtureJudge", () => {
  const names = listJudgeFixtures();

  it("has recorded fixtures", () => {
    expect(names).toContain("hansa-good-call");
  });

  for (const name of names) {
    it(`${name}: the recorded judge output still catches its planted case`, async () => {
      const fixture = loadJudgeFixture(name);
      const c = cases.find((x) => x.name === fixture.case)!;
      expect(c).toBeDefined();
      const { result, usage } = await auditCall(normalizeCall(plantedRow(c, 900000), {}), {
        judge: fixtureJudge(name),
        rubric: hansaRubric,
        agentPrompt,
        agentLabel: "Hansa (HR)",
        reviewThreshold: 0.7,
      });
      expect(plantedMisses(c, result)).toEqual([]);
      expect(result.judge.model).toBe(fixture.judge_model);
      expect(usage).toEqual(fixture.response.usage);
    });
  }

  it("returns a fresh copy on every call", async () => {
    const judge = fixtureJudge("hansa-good-call");
    const call = { messages: [], schema: {} } as any;
    const first = await judge(call);
    (first.output as any).mutated = true;
    expect((await judge(call)).output).not.toHaveProperty("mutated");
  });

  it("names the available fixtures when one is missing", () => {
    expect(() => fixtureJudge("no-such-fixture")).toThrow(/have: .*hansa-good-call/);
    expect(() => fixtureJudge("../package")).toThrow(/no judge fixture/);
  });
});

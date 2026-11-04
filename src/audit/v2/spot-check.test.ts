import { describe, expect, it } from "bun:test";
import { compareBlind, istWeekRange, istWeekStart, pickSpotChecks, seededRandom } from "./spot-check";

const candidates = (agent: string, ids: number[]) => ids.map((audit_id) => ({ audit_id, agent_code: agent }));

describe("pickSpotChecks (P2-18)", () => {
  const pool = [...candidates("hrms", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), ...candidates("project_manager", [11, 12, 13])];

  it("is reproducible from the seed, whatever order the candidates come in", () => {
    const a = pickSpotChecks(pool, 42, 5);
    const b = pickSpotChecks([...pool].reverse(), 42, 5);
    expect(b).toEqual(a);
    expect(pickSpotChecks(pool, 43, 5).picks).not.toEqual(a.picks);
  });

  it("takes up to N per agent and reports the agents that are short, including ones with no audits", () => {
    const { picks, shortfall } = pickSpotChecks(pool, 7, 5, ["caller", "hrms"]);
    expect(picks.filter((p) => p.agent_code === "hrms")).toHaveLength(5);
    expect(picks.filter((p) => p.agent_code === "project_manager").map((p) => p.audit_id).sort()).toEqual([11, 12, 13]);
    expect(shortfall).toEqual([
      { agent_code: "caller", available: 0, wanted: 5 },
      { agent_code: "project_manager", available: 3, wanted: 5 },
    ]);
  });

  it("picks a spread, not the first N", () => {
    const seen = new Set<number>();
    for (let seed = 1; seed <= 20; seed++) for (const p of pickSpotChecks(pool, seed, 5).picks) seen.add(p.audit_id);
    expect(seen.size).toBe(13);
  });

  it("seededRandom stays in [0, 1)", () => {
    const r = seededRandom(123);
    for (let i = 0; i < 1000; i++) {
      const x = r();
      expect(x >= 0 && x < 1).toBe(true);
    }
  });
});

describe("IST weeks", () => {
  it("a week starts on Monday 00:00 IST", () => {
    expect(istWeekStart(new Date("2026-11-04T10:00:00Z"))).toBe("2026-11-02"); // Wednesday
    expect(istWeekStart(new Date("2026-11-01T18:29:00Z"))).toBe("2026-10-26"); // Sunday 23:59 IST
    expect(istWeekStart(new Date("2026-11-01T18:30:00Z"))).toBe("2026-11-02"); // Monday 00:00 IST
    expect(istWeekRange("2026-11-02")).toEqual({ from: new Date("2026-11-01T18:30:00Z"), to: new Date("2026-11-08T18:30:00Z") });
  });

  it("rejects a date that isn't a Monday", () => {
    expect(() => istWeekRange("2026-11-03")).toThrow("isn't a Monday");
    expect(() => istWeekRange("2026-02-30")).toThrow("isn't a date");
    expect(() => istWeekRange("week")).toThrow("YYYY-MM-DD");
  });
});

describe("compareBlind", () => {
  const judge = { pass_fail: "FAIL" as const, business_outcome: "ACHIEVED" as const, failure_codes: ["AGENT_LOOP", "CALL_ERROR"] };

  it("agrees only when pass/fail, business outcome and the set of failure codes all match", () => {
    expect(compareBlind({ expected_pass_fail: "FAIL", expected_business_outcome: "ACHIEVED", expected_failure_codes: ["CALL_ERROR", "AGENT_LOOP"] }, judge)).toEqual({
      pass_fail: true,
      business_outcome: true,
      failure_codes: true,
      agree: true,
    });
    expect(compareBlind({ expected_pass_fail: "FAIL", expected_business_outcome: "ACHIEVED", expected_failure_codes: ["CALL_ERROR"] }, judge)).toMatchObject({
      failure_codes: false,
      agree: false,
    });
  });
});

describe("pickSpotChecks top-up", () => {
  it("takes each agent's own limit", () => {
    const pool = [...candidates("hrms", [1, 2, 3, 4]), ...candidates("caller", [5, 6, 7])];
    const { picks } = pickSpotChecks(pool, 9, (agent) => (agent === "hrms" ? 1 : 0));
    expect(picks.map((p) => p.agent_code)).toEqual(["hrms"]);
  });
});

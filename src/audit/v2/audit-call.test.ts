import { describe, expect, it } from "bun:test";
import { agentPrompt, cases, plantedMissesV2, plantedRow } from "../../../fixtures/planted/cases";
import type { Judge } from "@/audit/audit-call";
import { fixtureJudge, fixtureJudgeSequence, listJudgeFixtures, loadJudgeFixture } from "@/audit/judge/fixture-judge";
import { normalizeCall } from "@/audit/normalize";
import { auditCallV2 } from "./audit-call";
import { toCallRecord } from "./call-record";
import { JUDGE_PROMPT_VERSION } from "./judge/prompt";
import { seededDefinitions, seededGoal, seededScorecard } from "./seeded-config";

const scorecard = seededScorecard("hansa");
const DEFAULT_WEIGHTS = Object.fromEntries(scorecard.metrics.map((m) => [m.key, m.weight]));

/** Audits a planted case (as recorded: hansa v4, the planted prompt) with the given judge. */
function audit(caseName: string, judge: Judge, opts: { weights?: Record<string, number>; row?: Record<string, unknown> } = {}) {
  const raw = { ...plantedRow(cases.find((c) => c.name === caseName)!, 900000), ...opts.row };
  return auditCallV2(normalizeCall(raw, {}), toCallRecord(raw), {
    judge,
    scorecard,
    goal: seededGoal("hrms"),
    weights: opts.weights ?? DEFAULT_WEIGHTS,
    definitions: seededDefinitions(),
    instructions: agentPrompt,
    flow: { source: "prompt", text: agentPrompt.system_prompt, reason: "no Vajra conversation on this call" },
    agentLabel: "Hansa (HR)",
    reviewThreshold: 0.7,
  }).then((r) => r.result);
}

/** A judge that edits a recorded answer before returning it. */
const edited = (name: string, edit: (output: any) => void): Judge => async () => {
  const { response } = loadJudgeFixture(name, "v2");
  const copy = structuredClone(response);
  edit(copy.output);
  return copy;
};

describe("auditCallV2 on recorded judge answers (P1-7)", () => {
  it("every recorded v2 fixture still meets its planted case's expectations", async () => {
    for (const name of listJudgeFixtures("v2").filter((n) => n.startsWith("hansa-"))) {
      const fixture = loadJudgeFixture(name, "v2");
      expect(fixture.judge_prompt_version).toBe(JUDGE_PROMPT_VERSION);
      const result = await audit(fixture.case, fixtureJudge(name, "v2"));
      expect({ name, misses: plantedMissesV2(cases.find((c) => c.name === fixture.case)!, result) }).toEqual({ name, misses: [] });
    }
  });

  it("good call: passes, every metric accounted for, score computed by code", async () => {
    const r = await audit("good-call", fixtureJudge("hansa-good-call", "v2"));
    expect(r.passed).toBe(true);
    expect(r.system_goal).toEqual({ result: "PASS", failed: [] });
    expect(r.business_goal?.outcome).toBe("ACHIEVED");
    expect(r.metrics.map((m) => [m.key, m.source])).toEqual([
      ["flow_adherence", "judge"],
      ["query_handling", "judge"],
      ["troubleshooting", "judge"],
      ["communication_tone", "judge"],
      ["opening_closure", "judge"],
      ["language_match", "judge"],
      ["repetition", "judge"],
      ["stalling_filler", "rule"],
      ["interruptions", "unavailable"],
      ["pronunciation_numbers", "unavailable"],
    ]);
    expect(r.metrics.find((m) => m.key === "stalling_filler")).toMatchObject({ score: 10, max: 10, n_a: false });
    expect(r.metrics.filter((m) => m.source === "unavailable").every((m) => m.n_a && m.score === null)).toBe(true);
    expect(r.judge.attempts).toHaveLength(1);
    expect(r.needs_review).toBe(false);
  });

  it("loop: the rule fails S2 and the system goal, AGENT_LOOP (Major) zeroes Repetition, the business goal is still achieved", async () => {
    const r = await audit("agent-loop", fixtureJudge("hansa-agent-loop", "v2"));
    expect(r.checks.S2.result).toBe("FAIL");
    expect(r.checks.S2.rule?.result).toBe("FAIL");
    expect(r.system_goal).toEqual({ result: "FAIL", failed: ["S2"] });
    expect(r.business_goal?.outcome).toBe("ACHIEVED");
    expect(r.flags).toEqual([expect.objectContaining({ code: "AGENT_LOOP", source: "judge", severity: "major" })]);
    expect(r.metrics.find((m) => m.key === "repetition")?.zeroed_by).toBe("AGENT_LOOP");
    expect(r.passed).toBe(true); // Major doesn't fail the call on its own (PRD §4.5)
  });

  it("the loop rule fails S2 even when the judge passes it", async () => {
    const r = await audit(
      "agent-loop",
      edited("hansa-agent-loop", (o) => {
        o.system_checks = o.system_checks.map((c: any) => (c.check === "S2" ? { ...c, result: "PASS", evidence: [] } : c));
      }),
    );
    expect(r.checks.S2).toMatchObject({ result: "FAIL", rule: { result: "FAIL" }, judge: { result: "PASS" } });
  });

  it("critical flag: the call fails whatever its score", async () => {
    const r = await audit("ignored-stop", fixtureJudge("hansa-ignored-stop", "v2"));
    expect(r.passed).toBe(false);
    expect(r.failed_by).toContainEqual({ kind: "critical", code: "IGNORED_STOP_REQUEST" });
    expect(r.score).toBeGreaterThan(40);
  });

  it("a Critical or Major flag fails the system check it rolls up to; a Minor one doesn't (Open #21)", async () => {
    const stop = await audit("ignored-stop", fixtureJudge("hansa-ignored-stop", "v2"));
    expect(stop.checks.S2).toMatchObject({ result: "FAIL", flags: ["IGNORED_STOP_REQUEST"] });
    expect(stop.checks.S2.reason).toStartWith("IGNORED_STOP_REQUEST was flagged (critical): ");
    expect(stop.system_goal).toEqual({ result: "FAIL", failed: ["S2"] });

    const loop = await audit("agent-loop", fixtureJudge("hansa-agent-loop", "v2"));
    expect(loop.checks.S2.flags).toEqual(["AGENT_LOOP"]); // Major; S2 had already failed on the loop rule

    const flag = (code: string, turn: number) => (o: any) => {
      o.failure_conditions.push({ code, reason: "planted", evidence: [{ turns: [turn], quote: "x" }] });
    };
    const mismatch = await audit("good-call", edited("hansa-good-call", flag("OUTCOME_MISMATCH", 14))); // Critical → S4
    expect(mismatch.checks.S4).toMatchObject({ result: "FAIL", flags: ["OUTCOME_MISMATCH"] });
    expect(mismatch.system_goal.failed).toEqual(["S4"]);

    const hangup = await audit("good-call", edited("hansa-good-call", flag("PREMATURE_HANGUP", 19))); // Minor → S3
    expect(hangup.flags).toContainEqual(expect.objectContaining({ code: "PREMATURE_HANGUP", severity: "minor" }));
    expect(hangup.checks.S3).toMatchObject({ result: "PASS", flags: [] });
    expect(hangup.system_goal.result).toBe("PASS");
  });

  it("low judge confidence or quotes not in the transcript lower the auditor confidence and send the audit to review", async () => {
    const unsure = await audit("good-call", edited("hansa-good-call", (o) => (o.confidence = 0.1)));
    expect(unsure.needs_review).toBe(true);
    expect(unsure.review_reasons[0]).toMatch(/^auditor confidence 0\.\d+ is below 0\.7$/);

    const invented = await audit(
      "good-call",
      edited("hansa-good-call", (o) => {
        for (const m of o.metrics) m.evidence = m.evidence.map((e: any) => ({ ...e, quote: "words nobody said" }));
      }),
    );
    expect(invented.judge.evidence_validity).toBeLessThan(1);
    expect(invented.auditor_confidence).toBeLessThan((await audit("good-call", fixtureJudge("hansa-good-call", "v2"))).auditor_confidence);
  });

  it("a metric the judge marks N/A has no score and drops out of the score", async () => {
    const r = await audit(
      "good-call",
      edited("hansa-good-call", (o) => {
        const m = o.metrics.find((x: any) => x.key === "troubleshooting");
        Object.assign(m, { n_a: true, score: 0, evidence: [] });
      }),
    );
    expect(r.metrics.find((m) => m.key === "troubleshooting")).toMatchObject({ n_a: true, score: null, source: "judge" });
    expect(r.score).not.toBeNull();
  });

  it("an agent that never spoke: S1 fails and NO_AGENT_SPEECH (rule, Critical) fails the call", async () => {
    const silent = { transcriptions: [{ speaker: "user", text: "Hello? Hello?" }] };
    const r = await audit(
      "good-call",
      edited("hansa-good-call", (o) => {
        o.metrics = o.metrics.map((m: any) => ({ ...m, n_a: true, score: 0, evidence: [] }));
        o.system_checks = o.system_checks.map((c: any) => ({ ...c, evidence: [] }));
        o.business_goal.evidence = [];
        o.failure_conditions = [];
      }),
      { row: silent },
    );
    expect(r.checks.S1).toMatchObject({ result: "FAIL", flags: ["NO_AGENT_SPEECH"] });
    expect(r.flags).toContainEqual(expect.objectContaining({ code: "NO_AGENT_SPEECH", source: "rule", severity: "critical" }));
    expect(r.passed).toBe(false);
  });

  it("asks for the goal config's required outputs and required variables when the call's save tools list none", async () => {
    let asked: any;
    const raw = plantedRow(cases.find((c) => c.name === "good-call")!, 900000);
    const goal = { ...seededGoal("hrms"), required_outputs: ["notice_period"], system_checks: { ...seededGoal("hrms").system_checks, required_variables: ["current_ctc"] } };
    await auditCallV2(normalizeCall(raw, {}), toCallRecord(raw), {
      judge: async (call) => ((asked = call), fixtureJudge("hansa-good-call", "v2")(call)),
      scorecard,
      goal,
      weights: DEFAULT_WEIGHTS,
      definitions: seededDefinitions(),
      instructions: agentPrompt,
      flow: { source: "prompt", text: agentPrompt.system_prompt, reason: "no Vajra conversation on this call" },
      agentLabel: "Hansa (HR)",
      reviewThreshold: 0.7,
    });
    expect(asked.schema.properties.business_goal.properties.required_outputs.items.properties.key.enum).toEqual(["notice_period", "current_ctc"]);
    expect(asked.messages[0].content).toContain("Required outputs to extract: notice_period, current_ctc");
  });

  it("wrong person: business goal N/A with its reason", async () => {
    const r = await audit("wrong-person", fixtureJudge("hansa-wrong-person", "v2"));
    expect(r.business_goal).toMatchObject({ outcome: "NOT_APPLICABLE", reason_code: "WRONG_PERSON" });
  });

  it("a rule flag needs no judge: CALL_ERROR fails the call", async () => {
    const r = await audit("good-call", fixtureJudge("hansa-good-call", "v2"), { row: { ended_reason: "system_error" } });
    expect(r.flags).toContainEqual(expect.objectContaining({ code: "CALL_ERROR", source: "rule", severity: "critical" }));
    expect(r.passed).toBe(false);
  });

  it("a weight-0 metric is not sent to the judge and gets no result", async () => {
    const weights = { ...DEFAULT_WEIGHTS, troubleshooting: 0, flow_adherence: 20 };
    const judge = edited("hansa-good-call", (o) => {
      o.metrics = o.metrics.filter((m: any) => m.key !== "troubleshooting");
    });
    let asked: any;
    const r = await audit("good-call", async (call) => ((asked = call), judge(call)), { weights });
    expect(asked.schema.properties.metrics.items.properties.key.enum).not.toContain("troubleshooting");
    expect(r.metrics.map((m) => m.key)).not.toContain("troubleshooting");
    expect(r.metrics).toHaveLength(9);
    expect(r.weights_used).toEqual(weights);
  });
});

describe("one retry, then needs review (PRD §7)", () => {
  it("malformed JSON, then a good answer: uses the retry, tells the judge why the first was rejected", async () => {
    const judge = fixtureJudgeSequence(["v2-malformed-json", "hansa-agent-loop"]);
    const r = await audit("agent-loop", judge);
    expect(judge.calls).toHaveLength(2);
    expect(judge.calls[1]!.messages.at(-1)!.content).toContain("Your previous answer was rejected: the response is not valid JSON");
    expect(r.judge.attempts.map((a) => a.errors)).toEqual([["the response is not valid JSON"], []]);
    expect(r.needs_review).toBe(false);
    expect(r.score).not.toBeNull();
  });

  it("malformed twice: no judge part, rules only, no score, needs review", async () => {
    const r = await audit("agent-loop", fixtureJudgeSequence(["v2-malformed-json", "v2-malformed-json"]));
    expect(r.score).toBeNull();
    expect(r.passed).toBeNull();
    expect(r.business_goal).toBeNull();
    expect(r.checks.S2.result).toBe("FAIL"); // the loop rule still holds
    expect(r.checks.S3).toMatchObject({ result: "NOT_APPLICABLE", judge: null });
    expect(r.metrics.map((m) => m.source)).toEqual(["rule", "unavailable", "unavailable"]);
    expect(r.needs_review).toBe(true);
    expect(r.review_reasons[0]).toContain("judge answer still unusable after one retry");
  });

  it("evidence citing a missing turn twice: uses the answer without that evidence, needs review", async () => {
    const r = await audit("agent-loop", fixtureJudgeSequence(["v2-bad-turns", "v2-bad-turns"]));
    expect(r.judge.attempts[1]!.errors).toEqual(["evidence cites turn 999, which the transcript (turns 1–23) does not have"]);
    expect(r.metrics.find((m) => m.key === "repetition")?.evidence).toEqual([]);
    expect(r.score).not.toBeNull();
    expect(r.needs_review).toBe(true);
  });

  it("a deduction without evidence twice: needs review", async () => {
    const r = await audit("agent-loop", fixtureJudgeSequence(["v2-no-evidence", "v2-no-evidence"]));
    expect(r.judge.attempts[0]!.errors).toEqual(["metric repetition lost points without evidence"]);
    expect(r.needs_review).toBe(true);
  });

  it("asks at most twice", async () => {
    const judge = fixtureJudgeSequence(["v2-bad-turns", "v2-bad-turns"]);
    await audit("agent-loop", judge);
    expect(judge.calls).toHaveLength(2);
  });
});

import { describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import golden from "../../../../fixtures/reviews/golden.json";
import { cases } from "../../../../fixtures/planted/cases";
import type { Judge } from "@/audit/audit-call";
import { fixtureJudge, fixtureJudgeSequence, loadJudgeFixture } from "@/audit/judge/fixture-judge";
import { auditCallV2 } from "../audit-call";
import { JUDGE_PROMPT_VERSION } from "../judge/prompt";
import { seededDefinitions, seededGoal, seededScorecard } from "../seeded-config";
import { agreement, gate, GOLDEN_CAP, retirementCandidates } from "./agreement";
import { expectedFor, type GoldenRow, verdictOf } from "./golden";
import { type CacheStats, cachedJudge } from "./judge-cache";
import { compareRuns, findReport, parseReport, renderReport, reportPath } from "./report";
import { evaluate, exitCode, goldenContexts, plantedContext } from "./run";

/** P1-19 tests: the fixture judge and the recorded review rows in fixtures/reviews/golden.json, never the LLM. */
const config = { scorecard: seededScorecard("hansa"), goal: seededGoal("hrms"), definitions: seededDefinitions() };
const caseNamed = (name: string) => cases.find((c) => c.name === name)!;
type Recorded = (typeof golden.rows)[number];

/** A recorded review row with the audit the reviewer saw, rebuilt from its planted case and judge fixture. */
async function goldenRow(r: Recorded): Promise<GoldenRow> {
  const ctx = plantedContext(caseNamed(r.case), config);
  const { result } = await auditCallV2(ctx.input, ctx.record, { ...ctx, judge: fixtureJudge(r.audited_with, "v2"), reviewThreshold: 0.7 });
  const { case: _c, audited_with: _a, ...row } = r;
  return { ...(row as Omit<GoldenRow, "audit">), audit: result };
}

/** A judge that answers planted cases and golden calls from the fixtures; `edits` change a recorded answer first. */
function judgeFor(edits: Record<string, (output: any) => void> = {}, calls?: { n: number }) {
  const fixtureFor = (key: string) =>
    key.startsWith("planted-")
      ? `hansa-${key.slice("planted-".length)}`
      : golden.rows.find((r) => `call-${r.call_id}` === key)!.audited_with;
  return (key: string): Judge =>
    async () => {
      if (calls) calls.n++;
      const response = structuredClone(loadJudgeFixture(fixtureFor(key), "v2").response);
      edits[key]?.(response.output);
      return response;
    };
}

async function run(
  opts: { planted?: string[]; edits?: Record<string, (output: any) => void>; rows?: GoldenRow[]; judge?: (key: string) => Judge } = {},
) {
  const rows = opts.rows ?? (await Promise.all(golden.rows.map(goldenRow)));
  return evaluate({
    date: "2026-10-29",
    promptVersion: JUDGE_PROMPT_VERSION,
    planted: (opts.planted ?? ["good-call", "agent-loop"]).map((name) => ({
      case: caseNamed(name),
      context: plantedContext(caseNamed(name), config),
    })),
    golden: rows.map((row) => ({
      row,
      context: plantedContext(caseNamed(golden.rows.find((r) => r.call_id === row.call_id)!.case), config),
    })),
    judgeFor: opts.judge ?? judgeFor(opts.edits),
    reviewThreshold: 0.7,
  });
}

describe("expected values from a review (migration 0013 semantics)", () => {
  it("normal: the audit's values with the corrections; blind: only what the reviewer entered", async () => {
    const [agree, dispute, blind] = await Promise.all(golden.rows.slice(0, 3).map(goldenRow));
    expect(expectedFor(agree!)).toMatchObject({
      pass_fail: "PASS",
      business_outcome: "ACHIEVED",
      failure_codes: [],
      checks: { S2: "PASS" },
    });
    expect(expectedFor(dispute!)).toMatchObject({
      pass_fail: "PASS",
      failure_codes: [],
      metrics: { repetition: 8, flow_adherence: 10 },
      checks: { S2: "PASS", S3: "PASS" },
    });
    expect(expectedFor(blind!)).toEqual({
      pass_fail: "FAIL",
      business_outcome: "NOT_ACHIEVED",
      failure_codes: ["IGNORED_STOP_REQUEST"],
      metrics: {},
      checks: {},
    });
  });
});

describe("eval:v2 on the fixture judge and recorded reviews (P1-19)", () => {
  it("planted cases pass when the judge catches the planted defect, and miss when it doesn't", async () => {
    expect((await run()).data.planted).toEqual([
      { name: "good-call", ok: true, misses: [] },
      { name: "agent-loop", ok: true, misses: [] },
    ]);
    const missed = await run({ edits: { "planted-agent-loop": (o) => (o.failure_conditions = []) } });
    expect(missed.data.planted[1]).toMatchObject({ name: "agent-loop", ok: false });
    expect(missed.data.planted[1]!.misses).toContain("missed AGENT_LOOP");
  });

  it("agreement over all reviews: metrics within one point, checks, pass/fail, outcome, precision and recall per code", async () => {
    const { all } = await run();
    expect(all.calls).toBe(4);
    expect(all.pass_fail).toEqual({ agree: 4, total: 4, rate: 1 });
    expect(all.business_outcome).toEqual({ agree: 4, total: 4, rate: 1 });
    expect(all.failure_code_sets).toEqual({ agree: 2, total: 4, rate: 0.5 });
    // Only the two normal reviews carry metrics and checks; the dispute moved repetition (judge 0) to 8 and S2 to PASS.
    expect(all.metrics.repetition).toEqual({ agree: 1, total: 2, rate: 0.5 });
    expect(all.metrics.flow_adherence).toEqual({ agree: 2, total: 2, rate: 1 });
    expect(all.metrics.query_handling).toEqual({ agree: 2, total: 2, rate: 1 }); // both N/A
    expect(all.checks).toEqual({
      S1: { agree: 2, total: 2, rate: 1 },
      S2: { agree: 1, total: 2, rate: 0.5 },
      S3: { agree: 2, total: 2, rate: 1 },
      S4: { agree: 2, total: 2, rate: 1 },
    });
    expect(all.codes).toEqual({
      AGENT_LOOP: { tp: 0, fp: 1, fn: 0, precision: 0, recall: null },
      CONTINUED_AFTER_WRONG_PERSON: { tp: 0, fp: 0, fn: 1, precision: null, recall: 0 },
      IGNORED_STOP_REQUEST: { tp: 1, fp: 0, fn: 0, precision: 1, recall: 1 },
    });
  });

  it("blind spot-checks only, and the step 16 gate", async () => {
    const r = await run();
    expect(r.blind.calls).toBe(2);
    expect(r.blind.pass_fail.rate).toBe(1);
    expect(r.blind.business_outcome.rate).toBe(1);
    expect(r.blind.failure_code_sets).toEqual({ agree: 1, total: 2, rate: 0.5 });
    expect(r.blind.metrics).toEqual({});
    expect(r.gate.met).toBe(false);
    expect(r.gate.parts).toEqual([
      { label: "blind spot-checks", value: "2/30", ok: false },
      { label: "pass/fail", value: "100% (2/2)", ok: true },
      { label: "business outcome", value: "100% (2/2)", ok: true },
      { label: "failure codes", value: "50% (1/2)", ok: false },
      { label: "IGNORED_STOP_REQUEST precision (Critical)", value: "100%", ok: true },
    ]);
  });

  it("the gate is met with 30 agreeing blind checks, and fails on a Critical code below 90% precision", async () => {
    const [, , blind] = await Promise.all(golden.rows.map(goldenRow));
    const rows = Array.from({ length: 30 }, (_, i) => ({ ...blind!, review_id: 1000 + i }));
    const ok = await run({ rows, planted: [] });
    expect(ok.gate.met).toBe(true);
    // the judge now also flags IGNORED_STOP_REQUEST on the wrong-person call, which the reviewer passed
    const wrong = await Promise.all(golden.rows.map(goldenRow));
    const many = [...rows, ...Array.from({ length: 4 }, (_, i) => ({ ...wrong[3]!, review_id: 2000 + i, expected_failure_codes: [] }))];
    const fp = await run({
      rows: many,
      planted: [],
      edits: {
        "call-900104": (o) =>
          o.failure_conditions.push({
            code: "IGNORED_STOP_REQUEST",
            reason: "kept going",
            evidence: [{ turns: [3], quote: "No problem" }],
          }),
      },
    });
    expect(fp.all.codes.IGNORED_STOP_REQUEST).toMatchObject({ tp: 30, fp: 4 });
    expect(fp.gate.parts.find((p) => p.label.startsWith("IGNORED_STOP_REQUEST"))).toEqual({
      label: "IGNORED_STOP_REQUEST precision (Critical)",
      value: "88.2%",
      ok: false,
    });
  });

  it("the biggest disagreements: weighted, with structured diffs for the report and reasons for the console", async () => {
    const { top } = await run();
    expect(top.map((d) => [d.call_id, d.weight, d.diffs])).toEqual([
      [900102, 10, ["AGENT_LOOP: judge only", "S2: judge FAIL, reviewer PASS", "repetition: judge 0, reviewer 8"]],
      [900104, 2, ["CONTINUED_AFTER_WRONG_PERSON: reviewer only"]],
    ]);
    expect(top[0]!.judge_reasons).toHaveLength(3);
    expect(top[0]!.note).toBe("Re-asked after an unclear reply; not a loop.");
  });

  it("the saved report has ids, codes and numbers, never transcript text, judge reasons or reviewer notes", async () => {
    const r = await run();
    const md = renderReport(r, { cache: { hits: 0, misses: 7 } });
    expect(md).toContain("# v2 judge eval · 2026-10-29 · " + JUDGE_PROMPT_VERSION);
    expect(md).toContain("- Judge calls: 7 new, 0 cached");
    expect(md).toContain("| Failure codes (same set) | 50% (2/4) |");
    expect(md).toContain("- call 900102 (review 102, normal, weight 10): AGENT_LOOP: judge only;");
    expect(md).toContain("## Step 16 gate: not met");
    for (const text of [
      "Rahul",
      "not a loop",
      "father",
      ...r.top.flatMap((d) => d.judge_reasons.map((x) => x.split(": ").slice(1).join(": "))),
    ]) {
      expect({ text, found: md.includes(text) }).toEqual({ text, found: false });
    }
    expect(parseReport(md)).toEqual(r.data);
  });
});

describe("eval:v2 --compare", () => {
  it("passes on an unchanged judge; fails when a planted case breaks or an agreement number drops", async () => {
    const before = await run();
    expect(compareRuns(before.data, before.data, before.pairs, "old.md")).toEqual({
      against: "old.md",
      compared_calls: 4,
      regressions: [],
    });

    const broken = await run({ edits: { "planted-agent-loop": (o) => (o.failure_conditions = []) } });
    expect(compareRuns(before.data, broken.data, broken.pairs, "old.md").regressions).toEqual([
      expect.stringMatching(/^planted agent-loop now fails: missed AGENT_LOOP/),
    ]);

    // the new judge drops IGNORED_STOP_REQUEST on the blind call that had it right
    const worse = await run({ edits: { "call-900103": (o) => (o.failure_conditions = []) } });
    const { regressions } = compareRuns(before.data, worse.data, worse.pairs, "old.md");
    expect(regressions).toContain("all: failure codes (same set) dropped from 50% to 25%");
    expect(regressions).toContain("blind: recall IGNORED_STOP_REQUEST dropped from 100% to 0%");
    // and an improvement is not a regression
    expect(compareRuns(worse.data, before.data, before.pairs, "old.md").regressions).toEqual([]);
  });

  it("measures both runs on the calls they share", async () => {
    const before = await run();
    const old = { ...before.data, calls: before.data.calls.filter((c) => c.call_id !== 900101) };
    expect(compareRuns(old, before.data, before.pairs, "old.md").compared_calls).toBe(3);
  });

  it("finds the newest saved report of a version, or takes a path", () => {
    const dir = mkdtempSync(join(tmpdir(), "evals-"));
    for (const f of ["2026-10-01-v2-1.md", "2026-10-20-v2-1.md", "2026-10-25-v2-2.md"]) writeFileSync(join(dir, f), "x");
    expect(findReport("v2-1", dir)).toBe(join(dir, "2026-10-20-v2-1.md"));
    expect(() => findReport("v2-9", dir)).toThrow("no saved eval for judge prompt version v2-9");
    expect(findReport(join(dir, "2026-10-25-v2-2.md"))).toBe(join(dir, "2026-10-25-v2-2.md"));
  });
});

describe("judge cache", () => {
  it("a second run of unchanged calls makes no judge calls; a changed request does", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-cache-"));
    const calls = { n: 0 };
    const inner = judgeFor({}, calls);
    const stats: CacheStats = { hits: 0, misses: 0 };
    const cached = (model: string) => (key: string) => cachedJudge(inner(key), { dir, key, model, stats });

    await run({ judge: cached("m-2026-01-01") });
    expect([calls.n, stats]).toEqual([6, { hits: 0, misses: 6 }]);
    expect(readdirSync(dir).sort()).toEqual([
      "call-900101.json",
      "call-900102.json",
      "call-900103.json",
      "call-900104.json",
      "planted-agent-loop.json",
      "planted-good-call.json",
    ]);

    const again = await run({ judge: cached("m-2026-01-01") });
    expect([calls.n, stats]).toEqual([6, { hits: 6, misses: 6 }]);
    expect(again.data.planted.every((p) => p.ok)).toBe(true);

    await run({ judge: cached("m-2026-02-01") }); // another model: a different request
    expect(calls.n).toBe(12);
  });
});

describe("golden set cap", () => {
  it(`over ${GOLDEN_CAP} rows, offers the oldest plain agrees; never blind rows or disputes`, async () => {
    const [agree, dispute, blind] = await Promise.all(golden.rows.slice(0, 3).map(goldenRow));
    const day = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString();
    const rows: GoldenRow[] = [
      { ...blind!, review_id: 1, created_at: day(0) },
      { ...dispute!, review_id: 2, created_at: day(1) },
      { ...agree!, review_id: 3, created_at: day(2), corrected_scores: { repetition: 9 } }, // an agree with a correction is not plain
      ...Array.from({ length: GOLDEN_CAP }, (_, i) => ({ ...agree!, review_id: 10 + i, created_at: day(10 + i) })),
    ];
    expect(retirementCandidates(rows.slice(0, GOLDEN_CAP))).toEqual([]);
    expect(retirementCandidates(rows).map((r) => r.review_id)).toEqual([10, 11, 12]);
  });
});

describe("edges the main tests don't reach", () => {
  it("verdictOf leaves out metrics that need missing data, keeps rule-scored ones", async () => {
    const row = await goldenRow(golden.rows[0]!);
    const keys = Object.keys(verdictOf(row.audit!).metrics);
    expect(keys).toContain("stalling_filler");
    expect(keys).not.toContain("interruptions");
    expect(keys).not.toContain("pronunciation_numbers");
  });

  it("a normal review without a stored audit only has what the reviewer entered", async () => {
    const row = { ...(await goldenRow(golden.rows[1]!)), audit: null };
    expect(expectedFor(row)).toEqual({
      pass_fail: null,
      business_outcome: null,
      failure_codes: [],
      metrics: { repetition: 8 },
      checks: { S2: "PASS" },
    });
  });

  it("a metric the judge no longer scores is skipped, not counted as a disagreement", async () => {
    const row = await goldenRow(golden.rows[0]!);
    const verdict = verdictOf(row.audit!);
    delete verdict.metrics.repetition;
    const a = agreement([{ call_id: 1, kind: "normal", expected: expectedFor(row), verdict }]);
    expect(a.metrics.repetition).toBeUndefined();
    expect(a.metrics.flow_adherence).toEqual({ agree: 1, total: 1, rate: 1 });
  });

  it("with no blind checks the gate is not met and every rate is n/a", () => {
    expect(gate([])).toEqual({
      met: false,
      parts: [
        { label: "blind spot-checks", value: "0/30", ok: false },
        { label: "pass/fail", value: "n/a (0/0)", ok: false },
        { label: "business outcome", value: "n/a (0/0)", ok: false },
        { label: "failure codes", value: "n/a (0/0)", ok: false },
      ],
    });
  });

  it("a judge error is a planted miss, or an unaudited golden call; so is a call that can't be audited", async () => {
    const rows = await Promise.all(golden.rows.slice(0, 2).map(goldenRow));
    const fail: Judge = async () => {
      throw new Error("rate limited");
    };
    const r = await evaluate({
      date: "2026-10-29",
      promptVersion: JUDGE_PROMPT_VERSION,
      planted: [{ case: caseNamed("good-call"), context: plantedContext(caseNamed("good-call"), config) }],
      golden: [
        { row: rows[0]!, context: plantedContext(caseNamed("good-call"), config) },
        { row: rows[1]!, context: null, skip: "NOT_COMPLETED" },
      ],
      judgeFor: () => fail,
      reviewThreshold: 0.7,
    });
    expect(r.data.planted).toEqual([{ name: "good-call", ok: false, misses: ["error: rate limited"] }]);
    expect(r.unaudited).toEqual([
      { call_id: 900101, reason: "judge error: rate limited" },
      { call_id: 900102, reason: "NOT_COMPLETED" },
    ]);
    expect(r.pairs).toEqual([]);
    expect(r.data.judge_model).toBeNull();
  });

  it("goldenContexts: a call gone from voice_call_logs, a call that now skips, and one that loads", async () => {
    const rows = await Promise.all(golden.rows.slice(0, 3).map(goldenRow));
    const ctx = plantedContext(caseNamed("good-call"), config);
    const out = await goldenContexts(rows, [{ id: "900102" }, { id: 900103 }], async (raw) =>
      Number(raw.id) === 900102 ? { context: null, skip: "PLAYGROUND", input: ctx.input } : { context: ctx, skip: null },
    );
    expect(out.map((g) => [g.row.call_id, g.context ? "context" : g.skip])).toEqual([
      [900101, "not in voice_call_logs (or no transcript)"],
      [900102, "PLAYGROUND"],
      [900103, "context"],
    ]);
  });

  it("exit code: 1 on a planted miss or a compare regression, else 0", () => {
    const data = (ok: boolean) => ({
      data: { date: "", judge_prompt_version: "", judge_model: null, planted: [{ name: "x", ok, misses: [] }], calls: [] },
    });
    const cmp = (regressions: string[]) => ({ against: "old.md", compared_calls: 0, regressions });
    expect(exitCode(data(true))).toBe(0);
    expect(exitCode(data(true), cmp([]))).toBe(0);
    expect(exitCode(data(false))).toBe(1);
    expect(exitCode(data(true), cmp(["all: pass/fail dropped from 100% to 50%"]))).toBe(1);
  });

  it("the report shows unaudited calls, retirement candidates, the comparison and metrics under the 85% target", async () => {
    const r = await run();
    const [agree] = await Promise.all(golden.rows.slice(0, 1).map(goldenRow));
    const md = renderReport(
      { ...r, unaudited: [{ call_id: 7, reason: "NOT_COMPLETED" }], retire: [{ ...agree!, review_id: 55, call_id: 8 }] },
      {
        cache: { hits: 1, misses: 0 },
        comparison: { against: "docs/evals/old.md", compared_calls: 4, regressions: ["all: pass/fail dropped from 100% to 75%"] },
      },
    );
    expect(md).toContain("## Golden calls not audited\n\n- call 7: NOT_COMPLETED");
    expect(md).toContain("- review 55 (call 8, 2026-10-01)");
    expect(md).toContain("## Compared with docs/evals/old.md: FAILED");
    expect(md).toContain("- all: pass/fail dropped from 100% to 75%");
    expect(md).toContain("| Metric repetition (within 1) | 50% (1/2) · below the 85% target |");
    expect(md).toContain("| Metric flow_adherence (within 1) | 100% (2/2) |");
    expect(() => parseReport("# no data here")).toThrow("report has no eval-data block");
    expect(() => findReport("missing.md")).toThrow("no report at missing.md");
  });

  it("the cache keeps a retry too, and refuses a key that isn't a plain name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-cache-"));
    const stats: CacheStats = { hits: 0, misses: 0 };
    const ctx = plantedContext(caseNamed("agent-loop"), config);
    const once = async () => {
      const inner = fixtureJudgeSequence(["v2-malformed-json", "hansa-agent-loop"]);
      const judge = cachedJudge(inner, { dir, key: "planted-agent-loop", model: "m", stats });
      const { result } = await auditCallV2(ctx.input, ctx.record, { ...ctx, judge, reviewThreshold: 0.7 });
      return { calls: inner.calls.length, attempts: result.judge.attempts.length };
    };
    expect(await once()).toEqual({ calls: 2, attempts: 2 });
    expect(await once()).toEqual({ calls: 0, attempts: 2 });
    expect(stats).toEqual({ hits: 2, misses: 2 });
    expect(() => cachedJudge(fixtureJudge("hansa-good-call", "v2"), { dir, key: "../x", model: "m", stats })).toThrow(
      'bad cache key "../x"',
    );
  });
});

describe("eval:v2 --draft", () => {
  it("saves a draft run beside the published baseline, never over it, and says it used drafts", async () => {
    expect(reportPath("2026-10-29", "v2-1")).toBe("docs/evals/2026-10-29-v2-1.md");
    expect(reportPath("2026-10-29", "v2-1", true)).toBe("docs/evals/2026-10-29-v2-1-draft.md");
    const dir = mkdtempSync(join(tmpdir(), "evals-"));
    writeFileSync(reportPath("2026-10-28", "v2-1", false, dir), "x");
    writeFileSync(reportPath("2026-10-29", "v2-1", true, dir), "x");
    expect(findReport("v2-1", dir)).toBe(join(dir, "2026-10-28-v2-1.md")); // --compare skips draft runs

    const r = await run();
    const md = renderReport(r, { cache: { hits: 0, misses: 0 }, draft: true });
    expect(md).toStartWith(`# v2 judge eval · 2026-10-29 · ${JUDGE_PROMPT_VERSION} · drafts\n`);
    expect(md).toContain("Graded with the agents' unpublished scorecard and goal drafts");
    expect(renderReport(r, { cache: { hits: 0, misses: 0 } })).not.toContain("drafts");
  });
});

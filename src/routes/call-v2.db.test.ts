import { describe, expect, it } from "bun:test";
import { cases, plantedRow } from "../../fixtures/planted/cases";
import { fixtureJudge } from "@/audit/judge/fixture-judge";
import { runAuditV2 } from "@/audit/v2/run-audit";
import { pickSpotChecks } from "@/audit/v2/spot-check";
import { createMigrator } from "@/db/migrator";
import { dbTestsEnabled, withTestDb } from "@/db/test-db";
import type { AuthEnv } from "@/middleware/auth";
import { callV2Router } from "@/routes/call-v2";
import { spotCheckRouter } from "@/routes/spot-check";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { QueryTypes, type Sequelize } from "sequelize";
import { ZodError } from "zod";

const MODEL = "gpt-5.4-mini-2026-03-17";
const WEEK = "2026-11-02";

/** The app's routers behind a fake session ("admin") and the app's error handling. */
function app(sequelize: Sequelize, v2 = true) {
  const a = new Hono<AuthEnv>()
    .use(async (c, next) => {
      c.set("username", "admin");
      await next();
    })
    .route("/", callV2Router(() => sequelize, () => v2))
    .route("/", spotCheckRouter(() => sequelize, () => v2));
  a.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ message: err.message }, err.status);
    if (err instanceof ZodError) return c.json({ message: "Invalid request" }, 400);
    throw err;
  });
  return a;
}
const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** Audits a planted case as call `id`, created on the given day, with its recorded v2 judge answer. */
const audit = (sequelize: Sequelize, caseName: string, id: number, created = "2026-11-03T06:00:00Z", fixture = `hansa-${caseName}`) =>
  runAuditV2(sequelize, { ...plantedRow(cases.find((c) => c.name === caseName)!, id), created_at: created }, {
    judge: { judge: fixtureJudge(fixture, "v2"), model: MODEL },
    force: true,
    triggeredBy: "admin",
    triggerMode: "single",
  });

/** Keys that would give the judge's verdict away on a blind item. */
const VERDICT_KEYS = ["score", "success_result", "passed", "flags", "failed_by", "business_goal", "checks", "metrics", "notes", "system_goal", "result"];
const keysOf = (value: unknown): string[] =>
  value && typeof value === "object" ? Object.entries(value).flatMap(([k, v]) => [k, ...keysOf(v)]) : [];

describe.skipIf(!dbTestsEnabled)("v2 call page API (P2-1, P2-3, P2-4)", () => {
  it("serves the current audit with rubrics, condition definitions, notes and history; an older one by id", () =>
    withTestDb(async (sequelize) => {
      await createMigrator(sequelize, { quiet: true }).up();
      const api = app(sequelize);
      expect(await (await api.request("/v2/calls/4242/audit")).json()).toEqual({ data: null });

      const first = await audit(sequelize, "agent-loop", 4242);
      const second = await audit(sequelize, "agent-loop", 4242);
      const { data } = (await (await api.request("/v2/calls/4242/audit")).json()) as any;
      expect(data.audit.id).toBe(second.id);
      expect(data.audit.result.notes.went_well.length).toBeGreaterThan(0);
      expect(data.context.scorecard).toMatchObject({ scorecard_id: "hansa", version: 4 });
      expect(data.context.metrics.find((m: any) => m.key === "repetition").rubric.anchors).toBeDefined();
      expect(data.context.conditions.find((c: any) => c.code === "AGENT_LOOP")).toMatchObject({ severity: "major", enabled: true });
      expect(data.context.goal.outcomes).toContain("ACHIEVED");
      expect(data.history.map((h: any) => [h.id, h.superseded_by])).toEqual([
        [second.id, null],
        [first.id, second.id],
      ]);

      const older = (await (await api.request(`/v2/audits/${first.id}`)).json()) as any;
      expect(older.data.audit.superseded_by).toBe(second.id);
      expect((await api.request("/v2/audits/999999")).status).toBe(404);
    }));

  it("saves agree, a multi-item dispute with notes, and flag as normal reviews by the signed-in user; refuses bad ones", () =>
    withTestDb(async (sequelize) => {
      await createMigrator(sequelize, { quiet: true }).up();
      const api = app(sequelize);
      const { id } = await audit(sequelize, "agent-loop", 4242);
      const post = (body: unknown) => api.request(`/v2/audits/${id}/reviews`, json(body));

      expect((await post({ verdict: "agree" })).status).toBe(201);
      const dispute = await post({
        verdict: "dispute",
        corrected_scores: { repetition: 8 },
        corrected_checks: { S2: "PASS" },
        expected_failure_codes: ["CRITICAL_HALLUCINATION"],
        item_notes: { "code:AGENT_LOOP": "Re-asked after noise, not a loop.", "code:CRITICAL_HALLUCINATION": "Invented the salary band." },
        note: "Two problems.",
      });
      expect(dispute.status).toBe(201);
      expect(((await dispute.json()) as any).data).toMatchObject({
        reviewer: "admin",
        kind: "normal",
        verdict: "dispute",
        corrected_scores: { repetition: 8 },
        corrected_checks: { S2: "PASS" },
        expected_failure_codes: ["CRITICAL_HALLUCINATION"],
        item_notes: { "code:AGENT_LOOP": "Re-asked after noise, not a loop." },
      });
      expect((await post({ verdict: "flag", note: "Listen to turn 13." })).status).toBe(201);

      const bad = await post({ verdict: "dispute", corrected_scores: { repetition: 99 } });
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as any).message).toContain("must be scored 0 to 10");
      expect((await post({ verdict: "maybe" })).status).toBe(400);

      const { data } = (await (await api.request(`/v2/audits/${id}`)).json()) as any;
      expect(data.reviews.map((r: any) => r.verdict)).toEqual(["flag", "dispute", "agree"]);
    }));

  it("keeps the completed audit current when a newer run fails; a review of the failed one is 409", () =>
    withTestDb(async (sequelize) => {
      await createMigrator(sequelize, { quiet: true }).up();
      const api = app(sequelize);
      const good = await audit(sequelize, "agent-loop", 4242);
      const down = async () => {
        throw new Error("judge down");
      };
      await runAuditV2(sequelize, plantedRow(cases.find((c) => c.name === "agent-loop")!, 4242), {
        judge: { judge: down, model: MODEL },
        force: true,
        triggeredBy: "admin",
        triggerMode: "single",
      }).catch(() => null);
      const [failed] = await sequelize.query<{ id: number }>("SELECT id FROM audit_results WHERE status = 'failed'", { type: QueryTypes.SELECT });
      expect(failed!.id).toBeGreaterThan(good.id);

      const current = ((await (await api.request("/v2/calls/4242/audit")).json()) as any).data;
      expect(current.audit.id).toBe(good.id);
      expect(current.history.map((h: any) => h.status)).toEqual(["failed", "completed"]);
      const review = await api.request(`/v2/audits/${failed!.id}/reviews`, json({ verdict: "agree" }));
      expect(review.status).toBe(409);
    }));

  it("is 404 with v2 off", () =>
    withTestDb(async (sequelize) => {
      await createMigrator(sequelize, { quiet: true }).up();
      const api = app(sequelize, false);
      for (const path of ["/v2/calls/1/audit", "/v2/audits/1", "/v2/spot-checks", "/v2/spot-checks/items/1"]) expect((await api.request(path)).status).toBe(404);
      expect((await api.request("/v2/audits/1/reviews", json({ verdict: "agree" }))).status).toBe(404);
    }));
});

describe.skipIf(!dbTestsEnabled)("AI judge evaluation report", () => {
  it("measures reviews against the audits they reviewed, without calling the judge or saving anything", () =>
    withTestDb(async (sequelize) => {
      await createMigrator(sequelize, { quiet: true }).up();
      const api = app(sequelize);
      const report = async () => ((await (await api.request("/v2/spot-checks/report")).json()) as any).data;
      expect(await report()).toMatchObject({ calls: 0, blind_calls: 0, overall: { rate: null }, parameters: [] });

      const loop = await audit(sequelize, "agent-loop", 7001);
      const good = await audit(sequelize, "good-call", 7002);
      const flagged = await audit(sequelize, "good-call", 7003);
      const post = (id: number, body: unknown) => api.request(`/v2/audits/${id}/reviews`, json(body));
      await post(loop.id, { verdict: "dispute", expected_failure_codes: [] }); // "this wasn't a loop"
      await post(good.id, { verdict: "agree" });
      await post(flagged.id, { verdict: "flag" }); // a flag isn't an answer

      const before = await sequelize.query("SELECT id FROM review", { type: QueryTypes.SELECT });
      const r = await report();
      expect(r).toMatchObject({ calls: 2, blind_calls: 0, gate_met: false });
      expect(r.parameters.find((p: any) => p.key === "failure_codes")).toMatchObject({ agree: 1, total: 2 });
      expect(r.parameters.find((p: any) => p.key === "pass_fail")).toMatchObject({ agree: 2, total: 2 });
      expect(r.parameters[0].key).toBe("failure_codes");
      expect(r.insights).toContain("Stuck in a loop was flagged wrongly in 1 of 1 flagged calls.");
      expect(r.early_signal).toBe(true);
      expect(await sequelize.query("SELECT id FROM review", { type: QueryTypes.SELECT })).toEqual(before);

      // A retired row leaves the golden set, and so the report.
      await sequelize.query("UPDATE review SET in_golden_set = false WHERE audit_id = $1", { bind: [good.id] });
      expect((await report()).calls).toBe(1);

      expect((await app(sequelize, false).request("/v2/spot-checks/report")).status).toBe(404);
    }));
});

describe.skipIf(!dbTestsEnabled)("blind spot-checks (P2-18)", () => {
  it("draws a reproducible sample, says who is short, hides the verdict until the blind answer is saved", () =>
    withTestDb(async (sequelize) => {
      await createMigrator(sequelize, { quiet: true }).up();
      const api = app(sequelize);
      const ids: number[] = [];
      for (let i = 0; i < 3; i++) ids.push((await audit(sequelize, "agent-loop", 5000 + i)).id);
      await audit(sequelize, "good-call", 6000, "2026-10-20T06:00:00Z"); // another week

      const sample = ((await (await api.request(`/v2/spot-checks?week=${WEEK}`)).json()) as any).data;
      const hansa = sample.agents.find((a: any) => a.agent_code === "hrms");
      expect(hansa.items.map((i: any) => i.audit_id).sort()).toEqual([...ids].sort());
      expect(sample.shortfall).toContainEqual({ agent_code: "hrms", available: 3, wanted: 5 });

      // Reproducible: the stored seed and candidates give the same picks.
      const [draw] = await sequelize.query<any>("SELECT seed, per_agent, candidate_ids, audit_ids FROM spot_check_sample", { type: QueryTypes.SELECT });
      const again = pickSpotChecks(draw.candidate_ids.map((audit_id: number) => ({ audit_id, agent_code: "hrms" })), Number(draw.seed), draw.per_agent);
      expect(again.picks.map((p) => p.audit_id)).toEqual(draw.audit_ids);
      // Opening the week again doesn't draw again.
      await api.request(`/v2/spot-checks?week=${WEEK}`);
      expect((await sequelize.query("SELECT id FROM spot_check_sample", { type: QueryTypes.SELECT })).length).toBe(1);

      // A top-up only adds audits made since; the page says how many it could add.
      const late = await audit(sequelize, "agent-loop", 5009);
      const offered = ((await (await api.request(`/v2/spot-checks?week=${WEEK}`)).json()) as any).data;
      expect(offered.can_top_up).toBe(1);
      const topped = ((await (await api.request(`/v2/spot-checks/top-up?week=${WEEK}`, { method: "POST" })).json()) as any).data;
      expect(topped.agents.find((a: any) => a.agent_code === "hrms").items.map((i: any) => i.audit_id)).toContain(late.id);
      expect(topped.draws).toHaveLength(2);

      const before = ((await (await api.request(`/v2/spot-checks/items/${ids[0]}`)).json()) as any).data;
      expect(before.revealed).toBeNull();
      expect(before.call.transcript.length).toBeGreaterThan(0);
      expect(keysOf(before).filter((k) => VERDICT_KEYS.includes(k))).toEqual([]);
      expect(JSON.stringify(before)).not.toContain("AGENT_LOOP\",\"source"); // no flag records

      // Answers the scorecard doesn't offer are refused, and nothing is saved.
      const blind = (body: Record<string, unknown>) =>
        api.request(`/v2/spot-checks/items/${ids[0]}`, json({ expected_pass_fail: "PASS", expected_business_outcome: "ACHIEVED", expected_failure_codes: [], ...body }));
      expect((await blind({ expected_failure_codes: ["MADE_UP"] })).status).toBe(400);
      const notOffered = ["ACHIEVED", "PARTIAL", "NOT_ACHIEVED", "NOT_APPLICABLE"].find((o) => !before.options.outcomes.includes(o));
      if (notOffered) expect((await blind({ expected_business_outcome: notOffered })).status).toBe(400);
      expect(((await (await api.request(`/v2/spot-checks/items/${ids[0]}`)).json()) as any).data.revealed).toBeNull();

      const saved = await api.request(
        `/v2/spot-checks/items/${ids[0]}`,
        json({ expected_pass_fail: "PASS", expected_business_outcome: "ACHIEVED", expected_failure_codes: ["AGENT_LOOP"], note: "Clear loop." }),
      );
      expect(saved.status).toBe(201);
      const after = ((await saved.json()) as any).data;
      expect(after.revealed.judge).toMatchObject({ pass_fail: "PASS", business_outcome: "ACHIEVED", failure_codes: ["AGENT_LOOP"] });
      expect(after.revealed.comparison.agree).toBe(true);
      expect(after.revealed.review).toMatchObject({ kind: "blind", verdict: "agree", reviewer: "admin" });

      // The blind answer counts in the evaluation report, on its own number too.
      const report = ((await (await api.request("/v2/spot-checks/report")).json()) as any).data;
      expect(report).toMatchObject({ calls: 1, blind_calls: 1, blind: { agree: 3, total: 3, rate: 1 }, gate_met: false });

      const twice = await api.request(
        `/v2/spot-checks/items/${ids[0]}`,
        json({ expected_pass_fail: "FAIL", expected_business_outcome: "ACHIEVED", expected_failure_codes: [] }),
      );
      expect(twice.status).toBe(409);
      expect((await api.request("/v2/spot-checks/items/999999")).status).toBe(404);
      expect((await api.request("/v2/spot-checks?week=2026-11-03")).status).toBe(400);
    }));
});

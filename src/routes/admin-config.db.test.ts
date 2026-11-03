import { createMigrator } from "@/db/migrator";
import { loadActiveConfig } from "@/db/config-store";
import { dbTestsEnabled, withTestDb } from "@/db/test-db";
import type { AuthEnv } from "@/middleware/auth";
import { adminConfigRouter } from "@/routes/admin-config";
import { conditionsRouter } from "@/routes/conditions";
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { QueryTypes, type Sequelize } from "sequelize";
import { ZodError } from "zod";

const KEYS = [
  "flow_adherence",
  "query_handling",
  "troubleshooting",
  "communication_tone",
  "opening_closure",
  "language_match",
  "repetition",
  "stalling_filler",
  "interruptions",
  "pronunciation_numbers",
];
/** Flow adherence 20, query handling 0, the rest 10: a valid set of weights that differs from the seeded 10 each. */
const FLOW_20 = KEYS.map((key) => ({ key, weight: key === "flow_adherence" ? 20 : key === "query_handling" ? 0 : 10 }));

/**
 * The app as `app.ts` mounts it, signed in as "admin" (the session middleware's job), with the same error mapping.
 * `v2` switches AUDIT_V2_ENABLED.
 */
function api(sequelize: Sequelize) {
  const flag = { v2: true };
  const app = new Hono<AuthEnv>()
    .use(async (c, next) => {
      c.set("username", "admin");
      await next();
    })
    .route("/v1/audit", conditionsRouter(() => sequelize, () => flag.v2))
    .route("/v1/audit", adminConfigRouter(() => sequelize, () => flag.v2));
  app.onError((err, c) => c.json({ message: err.message }, err instanceof HTTPException ? err.status : err instanceof ZodError ? 400 : 500));
  const send = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/v1/audit${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };
  return { flag, send };
}

const all = <T extends object>(sequelize: Sequelize, sql: string) => sequelize.query<T>(sql, { type: QueryTypes.SELECT });
const log = (sequelize: Sequelize, entity: string) =>
  all<{ config_key: string; version: number; action: string; changed_by: string; fields: string[] }>(
    sequelize,
    `SELECT config_key, version, action, changed_by, ARRAY(SELECT jsonb_array_elements(changes)->>'field') AS fields
       FROM config_change WHERE entity = '${entity}' ORDER BY id`,
  );

/** A completed v2 audit on `default` v4 with raw scores out of 10 (missing keys are N/A). */
async function seedAudit(sequelize: Sequelize, call_id: number, scores: Record<string, number>, over = "") {
  const [{ id }] = (await all<{ id: number }>(
    sequelize,
    `INSERT INTO audit_results (engine, source, call_id, business_id, agent_code, rubric_version, status, call, score, scorecard_id, scorecard_version)
     VALUES ('v2', 'voice_call_logs', ${call_id}, 7, 'caller', 'default@4', 'completed', '{}', 50, 'default', 4) RETURNING id`,
  )) as [{ id: number }];
  for (const key of KEYS) {
    const score = scores[key] ?? null;
    await sequelize.query(
      `INSERT INTO metric_result (audit_id, metric_id, score, max, n_a)
       SELECT $1::int, id, $2::numeric, 10, $3::boolean FROM metric WHERE scorecard_id = 'default' AND scorecard_version = 4 AND key = $4`,
      { bind: [id, score, score === null, key] },
    );
  }
  if (over) await sequelize.query(`UPDATE audit_results SET ${over} WHERE id = ${id}`);
  return id;
}
const eight = (score: number, over: Record<string, number> = {}) => ({ ...Object.fromEntries(KEYS.slice(0, 8).map((k) => [k, score])), ...over });

describe.skipIf(!dbTestsEnabled)("scorecard and goal admin API (P1-18, P1-20)", () => {
  it("every route is 404 while v2 is off", () =>
    withTestDb(async (sequelize) => {
      await createMigrator(sequelize, { quiet: true }).up();
      const { flag, send } = api(sequelize);
      flag.v2 = false;
      const calls: [string, string, unknown?][] = [
        ["GET", "/scorecards"],
        ["GET", "/scorecards/default"],
        ["POST", "/scorecards/default/draft"],
        ["PATCH", "/scorecards/default/draft", { nonsense: true }],
        ["GET", "/scorecards/default/simulation"],
        ["GET", "/scorecards/default/history"],
        ["GET", "/goal-templates"],
        ["GET", "/goals"],
        ["GET", "/goals/caller"],
        ["POST", "/goals/caller/draft", {}],
        ["PATCH", "/goals/caller/draft", {}],
        ["POST", "/goals/caller/publish"],
        ["DELETE", "/goals/caller/draft"],
        ["GET", "/goals/caller/history"],
      ];
      for (const [method, path, body] of calls) expect([method, path, (await send(method, path, body)).status]).toEqual([method, path, 404]);
      expect(await all(sequelize, "SELECT 1 FROM scorecard WHERE status = 'draft' UNION ALL SELECT 1 FROM goal_config WHERE status = 'draft'")).toEqual([]);
    }));

  it("scorecards: list, start a draft, save weights, metric fields and conditions, publish, history", () =>
    withTestDb(async (sequelize) => {
      await createMigrator(sequelize, { quiet: true }).up();
      const { send } = api(sequelize);

      const list = await send("GET", "/scorecards");
      expect(list.body.data.map((s: any) => [s.scorecard_id, s.published, s.draft, s.agents.map((a: any) => a.code)])).toEqual([
        ["default", 4, null, ["caller", "project-manager"]],
        ["hansa", 4, null, ["hrms"]],
      ]);
      expect((await send("GET", "/scorecards/default")).body.data).toMatchObject({ draft: null, changes: [], base: null });
      expect((await send("GET", "/scorecards/hansa@1")).status).toBe(404);
      expect((await send("PATCH", "/scorecards/default/draft", { pass_threshold: 50 })).status).toBe(404); // no draft yet

      const started = await send("POST", "/scorecards/default/draft");
      expect([started.status, started.body.data.draft.version, started.body.data.base, started.body.data.draft.created_by]).toEqual([201, 5, 4, "admin"]);
      expect((await send("POST", "/scorecards/default/draft")).status).toBe(409);

      // Weights: refused unless they total 100; saved otherwise, and shown as the draft's changes.
      const uneven = await send("PATCH", "/scorecards/default/draft", { metrics: [{ key: "flow_adherence", weight: 20 }] });
      expect([uneven.status, uneven.body.message]).toEqual([400, "weights total 110, not 100"]);
      const weights = await send("PATCH", "/scorecards/default/draft", { metrics: FLOW_20 });
      expect(weights.status).toBe(200);
      expect(weights.body.data.changes.map((c: any) => [c.field, c.before, c.after])).toEqual([
        ["metric.flow_adherence.weight", 10, 20],
        ["metric.query_handling.weight", 10, 0],
      ]);

      // Rubric, applicability, auto-fail and the threshold; method can't change.
      const fields = await send("PATCH", "/scorecards/default/draft", {
        pass_threshold: 45,
        metrics: [{ key: "opening_closure", rubric: { anchors: { 5: "Greeted but no recap" } }, applicability: "Never", auto_fail: true }],
      });
      expect(fields.status).toBe(200);
      const opening = fields.body.data.draft.metrics.find((m: any) => m.key === "opening_closure");
      expect([fields.body.data.draft.pass_threshold, opening.rubric.anchors["5"], opening.applicability, opening.auto_fail]).toEqual([
        45,
        "Greeted but no recap",
        "Never",
        true,
      ]);
      const method = await send("PATCH", "/scorecards/default/draft", { metrics: [{ key: "repetition", method: "llm" }] });
      expect(method.status).toBe(400);
      expect(method.body.message).toContain("the method can't be changed here");

      // Conditions: severity and on/off; Major needs a metric; a condition whose data doesn't exist stays off.
      const conditions = await send("PATCH", "/scorecards/default/draft", {
        conditions: [
          { code: "AGENT_LOOP", severity: "critical" },
          { code: "PREMATURE_HANGUP", enabled: false },
        ],
      });
      expect(conditions.status).toBe(200);
      expect((await send("PATCH", "/scorecards/default/draft", { conditions: [{ code: "PREMATURE_HANGUP", severity: "major" }] })).status).toBe(400);
      const needsData = await send("PATCH", "/scorecards/default/draft", { conditions: [{ code: "UNRESPONSIVE_AGENT", enabled: true }] });
      expect([needsData.status, needsData.body.message]).toEqual([400, expect.stringContaining("can't be switched on")]);
      expect(conditions.body.data.library.find((l: any) => l.code === "UNRESPONSIVE_AGENT").needs_data).toContain("timing");

      // Still not live: the agents are on v4 until it is published.
      expect((await loadActiveConfig(sequelize, "caller", null)).scorecard?.version).toBe(4);
      const published = await send("POST", "/scorecards/default/publish");
      expect([published.status, published.body.data.version]).toEqual([200, 5]);
      const caller = (await loadActiveConfig(sequelize, "caller", null)).scorecard!;
      expect([caller.version, caller.pass_threshold, caller.metrics[0]!.weight]).toEqual([5, 45, 20]);
      expect((await send("PATCH", "/scorecards/default/draft", { pass_threshold: 50 })).status).toBe(404);

      expect(await log(sequelize, "scorecard")).toEqual([
        { config_key: "default", version: 5, action: "draft_created", changed_by: "admin", fields: [] },
        {
          config_key: "default",
          version: 5,
          action: "edited",
          changed_by: "admin",
          fields: ["metric.flow_adherence.weight", "metric.query_handling.weight"],
        },
        {
          config_key: "default",
          version: 5,
          action: "edited",
          changed_by: "admin",
          fields: ["pass_threshold", "metric.opening_closure.rubric.anchors.5", "metric.opening_closure.applicability", "metric.opening_closure.auto_fail"],
        },
        {
          config_key: "default",
          version: 5,
          action: "edited",
          changed_by: "admin",
          fields: ["condition.AGENT_LOOP.severity", "condition.PREMATURE_HANGUP.enabled"],
        },
        expect.objectContaining({ version: 5, action: "published", changed_by: "admin" }),
      ]);

      const history = (await send("GET", "/scorecards/default/history")).body.data;
      expect(history.map((h: any) => [h.version, h.status, h.published_by, h.changes.length, h.log.length])).toEqual([
        [5, "published", "admin", 8, 5],
        [4, "published", "migration", 3, 0],
        [3, "published", "migration", 11, 0],
        [2, "published", "migration", 27, 0], // 10 metrics replace the 5 × 20 template
        [1, "published", "migration", 0, 0],
      ]);
      expect(history[0].changes.map((c: any) => c.field)).toContain("condition.AGENT_LOOP.severity");
    }));

  it("scorecards: discarding a draft logs it, and the next draft's history starts fresh", () =>
    withTestDb(async (sequelize) => {
      await createMigrator(sequelize, { quiet: true }).up();
      const { send } = api(sequelize);
      await send("POST", "/scorecards/hansa/draft");
      await send("PATCH", "/scorecards/hansa/draft", { pass_threshold: 55 });
      expect((await send("DELETE", "/scorecards/hansa/draft")).status).toBe(200);
      expect((await send("GET", "/scorecards/hansa")).body.data.draft).toBeNull();
      await send("POST", "/scorecards/hansa/draft");
      const [draft] = (await send("GET", "/scorecards/hansa/history")).body.data;
      expect([draft.version, draft.status, draft.log.map((l: any) => l.action)]).toEqual([5, "draft", ["draft_created"]]);
      expect((await log(sequelize, "scorecard")).map((l) => l.action)).toEqual(["draft_created", "edited", "discarded", "draft_created"]);
    }));

  it("simulation: re-scores the scorecard's current completed v2 audits with the draft, from stored scores only", () =>
    withTestDb(async (sequelize) => {
      await createMigrator(sequelize, { quiet: true }).up();
      const { send } = api(sequelize);
      // 35.0 (fails) on v4; 47.5 (passes) once flow adherence weighs 20 and query handling 0.
      const willPass = await seedAudit(sequelize, 1, eight(3, { flow_adherence: 10, query_handling: 0 }));
      // 50.0 (passes) on v4; 37.5 (fails) with the draft.
      const willFail = await seedAudit(sequelize, 2, eight(5, { flow_adherence: 0, query_handling: 10 }));
      // Left out: a superseded audit, a failed one, and one on another scorecard.
      await seedAudit(sequelize, 3, eight(5), `superseded_by = ${willPass}`);
      await seedAudit(sequelize, 4, eight(5), "status = 'failed'");
      await seedAudit(sequelize, 5, eight(5), "scorecard_id = 'hansa'");

      expect((await send("GET", "/scorecards/default/simulation")).status).toBe(404); // no draft
      await send("POST", "/scorecards/default/draft");
      await send("PATCH", "/scorecards/default/draft", { metrics: FLOW_20 });
      const sim = (await send("GET", "/scorecards/default/simulation?n=50")).body.data;
      expect(sim).toMatchObject({
        requested: 50,
        audits: 2,
        before: { version: 4, passed: 1, pass_rate: 50, average_score: 42.5 },
        after: { version: 5, passed: 1, pass_rate: 50, average_score: 42.5 },
        score_changed: 2,
        unscored: { audits: 0, metrics: [] },
      });
      expect(sim.flipped).toEqual([
        { audit_id: willFail, call_id: 2, before: { score: 50, passed: true }, after: { score: 37.5, passed: false } },
        { audit_id: willPass, call_id: 1, before: { score: 35, passed: false }, after: { score: 47.5, passed: true } },
      ]);
      // n is capped at 500, and nothing was written.
      expect((await send("GET", "/scorecards/default/simulation?n=9999")).body.data.requested).toBe(500);
      expect(await all(sequelize, "SELECT 1 FROM audit_rescore")).toEqual([]);
    }));

  it("goals: start from a template, save, publish, discard, history", () =>
    withTestDb(async (sequelize) => {
      await createMigrator(sequelize, { quiet: true }).up();
      const { send } = api(sequelize);

      const templates = (await send("GET", "/goal-templates")).body.data;
      expect(templates).toHaveLength(7);
      expect((await send("GET", "/goals")).body.data.map((g: any) => [g.agent_code, g.published, g.draft])).toEqual([
        ["hrms", 1, null],
        ["project-manager", 1, null],
        ["caller", 1, null],
      ]);
      expect((await send("GET", "/goals/sales-bot")).status).toBe(404);
      expect((await send("POST", "/goals/caller/draft", { template: "nope" })).status).toBe(400);

      const started = await send("POST", "/goals/caller/draft", { template: "book_demo" });
      expect(started.status).toBe(201);
      expect(started.body.data.draft).toMatchObject({
        version: 2,
        name: "Book a demo",
        required_outputs: ["demo_datetime", "contact_channel"],
        reason_codes: { ACHIEVED: ["DEMO_BOOKED"], PARTIAL: ["CALLBACK_REQUESTED", "DETAILS_REQUESTED"] },
        system_checks: { silence_limit_s: 8, required_variables: [], flow_steps: null },
      });
      expect(started.body.data.publish_errors).toEqual([]);
      expect((await send("POST", "/goals/caller/draft", {})).status).toBe(409);

      // Save: system goal settings; the silence limit can't be set; a bad reason code is refused.
      const saved = await send("PATCH", "/goals/caller/draft", { system_checks: { required_variables: ["outcome.demo_datetime"], flow_steps: ["Greet", "Pitch"] } });
      expect(saved.body.data.draft.system_checks).toEqual({ silence_limit_s: 8, required_variables: ["outcome.demo_datetime"], flow_steps: ["Greet", "Pitch"] });
      expect((await send("PATCH", "/goals/caller/draft", { system_checks: { silence_limit_s: 3 } })).status).toBe(400);
      expect((await send("PATCH", "/goals/caller/draft", { reason_codes: { ACHIEVED: ["ok"] } })).status).toBe(400);

      // Clearing Partial's criteria without its codes can be saved, not published.
      const incomplete = await send("PATCH", "/goals/caller/draft", { partial_success: [] });
      expect(incomplete.body.data.publish_errors).toEqual(["PARTIAL has reason codes but no partial success criteria"]);
      expect((await send("POST", "/goals/caller/publish")).status).toBe(400);
      await send("PATCH", "/goals/caller/draft", { reason_codes: { PARTIAL: [] } });

      expect((await loadActiveConfig(sequelize, "caller", null)).goal?.version).toBe(1);
      const published = await send("POST", "/goals/caller/publish");
      expect([published.status, published.body.data.published.version, published.body.data.draft]).toEqual([200, 2, null]);
      const active = (await loadActiveConfig(sequelize, "caller", null)).goal!;
      expect([active.version, active.name, active.system_checks.flow_steps]).toEqual([2, "Book a demo", ["Greet", "Pitch"]]);
      expect((await loadActiveConfig(sequelize, "project-manager", null)).goal?.version).toBe(1);

      expect((await send("POST", "/goals/caller/publish")).status).toBe(404);
      await send("POST", "/goals/hrms/draft", {});
      expect((await send("DELETE", "/goals/hrms/draft")).status).toBe(200);
      expect((await send("DELETE", "/goals/hrms/draft")).status).toBe(404);

      expect((await log(sequelize, "goal_config")).map((l) => [l.config_key, l.version, l.action, l.changed_by])).toEqual([
        ["caller", 2, "draft_created", "admin"],
        ["caller", 2, "edited", "admin"],
        ["caller", 2, "edited", "admin"],
        ["caller", 2, "edited", "admin"],
        ["caller", 2, "edited", "admin"],
        ["caller", 2, "published", "admin"],
        ["hrms", 2, "draft_created", "admin"],
        ["hrms", 2, "discarded", "admin"],
      ]);
      const history = (await send("GET", "/goals/caller/history")).body.data;
      expect(history.map((h: any) => [h.version, h.published_by])).toEqual([
        [2, "admin"],
        [1, "migration"],
      ]);
      expect(history[0].changes.map((c: any) => c.field)).toEqual(expect.arrayContaining(["name", "required_outputs", "system_checks.flow_steps"]));
    }));
});

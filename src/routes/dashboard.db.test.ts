import { describe, expect, it } from "bun:test";
import { createMigrator } from "@/db/migrator";
import { refreshAuditDays } from "@/db/rollup";
import { dbTestsEnabled, withTestDb } from "@/db/test-db";
import type { AuthEnv } from "@/middleware/auth";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { QueryTypes, type Sequelize } from "sequelize";
import { v2CallIds } from "@/db/call-filters";
import { dashboardRouter } from "./dashboard";

type Seed = {
  call_id: number;
  at: string;
  agent_id?: number;
  score?: number;
  pass?: "PASS" | "FAIL";
  system?: "PASS" | "FAIL";
  business?: string;
  reason?: string;
  codes?: string[];
  direction?: string;
  checks?: Record<string, string>;
  repetition?: number;
};

async function seed(db: Sequelize, s: Seed) {
  const [{ id }] = (await db.query<{ id: number }>(
    `INSERT INTO audit_results (engine, source, call_id, business_id, agent_code, agent_id, rubric_version, status, call, result,
       call_created_at, scorecard_id, scorecard_version, score, success_result, system_goal, business_goal, business_reason, failure_codes,
       needs_review, goal_version, trigger_mode)
     VALUES ('v2', 'voice_call_logs', $1, 1, NULL, $2, 'v2:default@2', 'completed', $3::jsonb, '{}', $4, 'default', 2, $5, $6, $7, $8, $9, $10,
       false, 1, 'single') RETURNING id`,
    {
      bind: [
        s.call_id,
        s.agent_id ?? 9,
        JSON.stringify({ call_type: s.direction ?? "outbound" }),
        s.at,
        s.score ?? 80,
        s.pass ?? "PASS",
        s.system ?? "PASS",
        s.business ?? "ACHIEVED",
        s.reason ?? null,
        s.codes ?? [],
      ],
      type: QueryTypes.SELECT,
    },
  ))!;
  for (const [code, result] of Object.entries(s.checks ?? {}))
    await db.query("INSERT INTO audit_check (audit_id, check_code, result) VALUES ($1, $2, $3)", { bind: [id, code, result] });
  if (s.repetition !== undefined)
    await db.query(
      `INSERT INTO metric_result (audit_id, metric_id, score, max, n_a)
       SELECT $1, id, $2, 10, false FROM metric WHERE scorecard_id = 'default' AND scorecard_version = 2 AND key = 'repetition'`,
      { bind: [id, s.repetition] },
    );
  return id;
}

async function seedSample(db: Sequelize) {
  await seed(db, { call_id: 1, at: "2026-11-02T06:00:00Z", repetition: 10 });
  await seed(db, { call_id: 2, at: "2026-11-02T07:00:00Z", score: 30, pass: "FAIL", system: "FAIL", business: "PARTIAL", codes: ["AGENT_LOOP"], checks: { S2: "FAIL" }, repetition: 4 });
  await seed(db, { call_id: 3, at: "2026-11-03T07:00:00Z", score: 65, business: "NOT_ACHIEVED", reason: "PRICE", direction: "inbound", checks: { S2: "PASS" } });
  await seed(db, { call_id: 4, at: "2026-10-30T07:00:00Z", score: 50, pass: "FAIL" }); // previous period
  await refreshAuditDays(db, ["2026-10-30", "2026-11-02", "2026-11-03"]);
  await db.query(
    `INSERT INTO daily_call_rollup (day, agent_code, direction, total, connected, not_connected) VALUES
       ('2026-11-02', 'caller', 'outbound', 10, 4, 5), ('2026-11-03', 'caller', 'inbound', 3, 1, 2), ('2026-10-30', 'caller', 'outbound', 2, 1, 1)`,
  );
}

describe.skipIf(!dbTestsEnabled)("GET /v2/dashboard and v2 click-through (P2-7)", () => {
  it("answers from the roll-ups, with denominators and the previous period; 404 with v2 off; 400 on a bad range", () =>
    withTestDb(async (db) => {
      await createMigrator(db, { quiet: true }).up();
      await seedSample(db);
      let v2 = true;
      const app = new Hono<AuthEnv>().route(
        "/v1/audit",
        dashboardRouter(
          () => db,
          () => v2,
        ),
      );
      app.onError((err, c) => c.json({ message: err.message }, err instanceof HTTPException ? err.status : 500));
      const get = async (qs: string) => {
        const res = await app.request(`/v1/audit/v2/dashboard?${qs}`);
        return { status: res.status, body: (await res.json()) as any };
      };

      const { status, body } = await get("from=2026-11-01&to=2026-11-03&compare=1");
      expect(status).toBe(200);
      const d = body.data;
      expect(d.kpis.total_calls.current).toEqual({ num: 13, den: 13, value: 1 });
      expect(d.kpis.connect_rate.current).toEqual({ num: 5, den: 12, value: 5 / 12 });
      expect(d.kpis.pass_rate.current).toEqual({ num: 2, den: 3, value: 2 / 3 });
      expect(d.kpis.pass_rate.previous).toEqual({ num: 0, den: 1, value: 0 });
      expect(d.kpis.business_goal_rate.current).toEqual({ num: 1, den: 3, value: 1 / 3 });
      expect(d.kpis.partial_share.current).toEqual({ num: 1, den: 3, value: 1 / 3 });
      expect(d.sample).toEqual({ audited: 3, sampled: 0, hand_picked: 3, low: true });
      // one call each; ties are ordered by label
      expect(d.failures.map((f: any) => [f.kind, f.key, f.calls]).sort()).toEqual([
        ["check", "S2", 1],
        ["condition", "AGENT_LOOP", 1],
        ["metric", "repetition", 1],
      ]);
      expect(d.funnel[0].stages.map((s: any) => s.calls)).toEqual([5, 3, 2, 3, 1]);
      expect(d.options.agents).toEqual([{ code: "caller", label: "Caller" }]);
      expect((await get("from=2026-11-01&to=2026-11-03&direction=inbound")).body.data.sample.audited).toBe(1);

      expect((await get("from=2026-11-04&to=2026-11-01")).status).toBe(400);
      expect((await get("from=2026-02-30")).status).toBe(400);
      v2 = false;
      expect((await get("")).status).toBe(404);
    }));

  it("v2CallIds lists the calls behind each dashboard number", () =>
    withTestDb(async (db) => {
      await createMigrator(db, { quiet: true }).up();
      await seedSample(db);
      const ids = async (q: Parameters<typeof v2CallIds>[1]) => (await v2CallIds(db, q))?.sort() ?? null;
      expect(await ids({})).toBeNull();
      expect(await ids({ audit: "audited" })).toEqual([1, 2, 3, 4]);
      expect(await ids({ success: "FAIL" })).toEqual([2, 4]);
      expect(await ids({ business_goal: "APPLICABLE" })).toEqual([1, 2, 3, 4]);
      expect(await ids({ business_goal: "NOT_ACHIEVED" })).toEqual([3]);
      expect(await ids({ business_goal: "PARTIAL" })).toEqual([2]);
      expect(await ids({ bucket: "ai_failure" })).toEqual([2]);
      expect(await ids({ check: "S2" })).toEqual([2]);
      expect(await ids({ audit: "audited", check_ok: "S2" })).toEqual([1, 3, 4]);
      expect(await ids({ metric_lost: "repetition" })).toEqual([2]);
      expect(await ids({ business_reason: "PRICE" })).toEqual([3]);
      expect(await ids({ failure_code: "AGENT_LOOP" })).toEqual([2]);
      expect(await ids({ min_score: 60, max_score: 80 })).toEqual([3]);
      expect(await ids({ scorecard: "default@2", goal_version: "caller@1" })).toEqual([1, 2, 3, 4]);
    }));
});

import { describe, expect, it, mock } from "bun:test";
import { createMigrator } from "@/db/migrator";
import { TEST_DB_PREFIX, dbTestsEnabled, withTestDb } from "@/db/test-db";
import sample from "../../fixtures/real/call-sample.json";

/** The call as voice_call_logs would return it (the fixture leaves out business and timestamps). */
const SOURCE_ROW = { ...sample, business_id: 7, agent_code: null, created_at: "2026-10-12T12:10:00.000Z" };

/** P0-4: a v2 audit of a call must not change anything the v1 API returns. */
describe.skipIf(!dbTestsEnabled)("v1 routes ignore engine = 'v2' rows", () => {
  it("returns the same responses after a newer v2 audit of the same call is stored", () =>
    withTestDb(async (sequelize, name) => {
      await createMigrator(sequelize, { quiet: true }).up();

      // Point the app's models at the throwaway database and fake the read-only source DB.
      // Routes are imported only after this, so they never see the real connection.
      mock.module("@/db/connection", () => ({ sequelize }));
      mock.module("@/services/call-source.db", () => ({
        sourceDbConfigured: () => true,
        getSourceCall: async (id: number) => (id === SOURCE_ROW.id ? SOURCE_ROW : null),
        listSourceCalls: async (q: { only_ids?: number[]; exclude_ids?: number[] }) => {
          const rows = [SOURCE_ROW].filter((r) => (!q.only_ids || q.only_ids.includes(r.id)) && !q.exclude_ids?.includes(r.id));
          return { rows, total: rows.length };
        },
        sourceCallCounts: async () => ({ completed: 1 }),
      }));
      const { tables } = await import("@/db");
      const { Hono } = await import("hono");
      const calls = (await import("@/routes/calls")).default;
      const audits = (await import("@/routes/audits")).default;
      // Never write anywhere but the throwaway database.
      expect(tables.AuditResult.sequelize!.getDatabaseName()).toBe(name);
      expect(name.startsWith(TEST_DB_PREFIX)).toBe(true);

      const app = new Hono().route("/", calls).route("/", audits);
      const call = { source: "voice_call_logs", call_id: SOURCE_ROW.id, business_id: 7, agent_id: 9, call: { call_id: SOURCE_ROW.id } as any };
      const v1 = await tables.AuditResult.create({
        ...call,
        rubric_version: "caller@1",
        status: "completed",
        overall_score: 82,
        success_result: "PASS",
        goal_result: "ACHIEVED",
        failure_codes: [],
        call_created_at: new Date(SOURCE_ROW.created_at),
      });

      const GETS = [
        "/calls",
        "/calls?sort=score_desc",
        "/calls?audit=audited",
        "/calls?success=PASS",
        `/calls/${SOURCE_ROW.id}`,
        "/calls/stats",
        "/audits",
        "/audits/stats",
        `/audits/${v1.id}`,
      ];
      const snapshot = async () => {
        const out: Record<string, unknown> = {};
        for (const path of GETS) {
          const res = await app.request(path);
          expect(res.status).toBe(200);
          out[path] = await res.json();
        }
        return out;
      };

      const before = await snapshot();
      expect((before[`/calls/${SOURCE_ROW.id}`] as any).data.audit.id).toBe(v1.id);
      expect((before["/audits"] as any).total).toBe(1);

      // Newer than the v1 row, with different outcomes, so any leak would change a response.
      const v2 = await tables.AuditResult.create({
        ...call,
        engine: "v2",
        rubric_version: "caller@v2-1",
        status: "completed",
        overall_score: 12,
        success_result: "FAIL",
        goal_result: "NOT_ACHIEVED",
        failure_codes: ["V2_ONLY"],
        needs_review: true,
        call_created_at: new Date(SOURCE_ROW.created_at),
      });

      expect(await snapshot()).toEqual(before);
      expect(((await (await app.request("/calls?audit=not_audited")).json()) as any).total).toBe(0);
      expect(((await (await app.request("/calls?failure_code=V2_ONLY")).json()) as any).total).toBe(0);
      expect((await app.request(`/audits/${v2.id}`)).status).toBe(404);
      expect((await app.request(`/audits/${v2.id}/recording`)).status).toBe(404);
      expect((await app.request(`/audits/${v2.id}/reaudit`, { method: "POST" })).status).toBe(404);
    }));
});

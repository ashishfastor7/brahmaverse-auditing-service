import { describe, expect, it, mock } from "bun:test";
import { createMigrator } from "@/db/migrator";
import { TEST_DB_PREFIX, dbTestsEnabled, withTestDb } from "@/db/test-db";
import { env } from "@/env";
import { agentPrompt, cases, variables } from "../../fixtures/planted/cases";

const good = cases.find((c) => c.name === "good-call")!;

/** A synthetic Hansa call as voice_call_logs would return it (planted good-call; no real person's data). */
const SOURCE_ROW = {
  id: 5001,
  business_id: 7,
  agent_id: 1,
  agent_code: null,
  prompt_code: agentPrompt.prompt_code,
  status: "completed",
  call_type: "outbound",
  provider: "plivo",
  voice_provider: "brahmaverse",
  is_playground: false,
  duration: 120,
  ended_reason: "hangup",
  recording_url: "https://recordings.example/5001.wav",
  summary: "Screening for the QA Engineer role, all questions answered.",
  turns: good.transcript.length,
  has_recording: true,
  has_summary: true,
  contact_name: variables.candidate_name,
  transcriptions: good.transcript.map(([speaker, text]) => ({ speaker, text })),
  outcome: good.outcome,
  data: { config: { prompt_code: agentPrompt.prompt_code, variables, is_playground: false }, metadata: { name: variables.candidate_name } },
  created_at: "2026-10-12T12:10:00.000Z",
  picked_at: "2026-10-12T12:10:14.000Z",
  ends_at: "2026-10-12T12:12:14.000Z",
};
/** A call that never connected: auditing it is recorded as skipped before any judge or RPC call. */
const NO_ANSWER_ROW = { ...SOURCE_ROW, id: 5009, status: "no_answer", transcriptions: [], turns: 0 };
/** Every audit timestamp is set to this, so the snapshot is the same on every run. */
const AUDITED_AT = "2026-10-12T12:30:00.000Z";
const auth = { Authorization: `Bearer ${env.AUDIT_API_TOKEN}` };

/**
 * P0-2: with AUDIT_V2_ENABLED off, every existing route returns what it returned before v2 (the snapshot).
 * P0-4: a v2 audit of a call must not change anything the v1 API returns.
 */
describe.skipIf(!dbTestsEnabled)("v1 routes", () => {
  it("match the pre-v2 snapshot, and ignore a newer engine = 'v2' audit", () =>
    withTestDb(async (sequelize, name) => {
      await createMigrator(sequelize, { quiet: true }).up();

      // Point the app's models at the throwaway database and fake the read-only source DB and recordings.
      // The app is imported only after this, so it never sees the real connection.
      mock.module("@/db/connection", () => ({ sequelize }));
      mock.module("@/services/call-source.db", () => ({
        sourceDbConfigured: () => true,
        getSourceCall: async (id: number) => (id === SOURCE_ROW.id ? SOURCE_ROW : id === NO_ANSWER_ROW.id ? NO_ANSWER_ROW : null),
        listSourceCalls: async (q: { only_ids?: number[]; exclude_ids?: number[] }) => {
          const rows = [SOURCE_ROW].filter((r) => (!q.only_ids || q.only_ids.includes(r.id)) && !q.exclude_ids?.includes(r.id));
          return { rows, total: rows.length };
        },
        sourceCallCounts: async () => ({ completed: 1 }),
      }));
      mock.module("@/services/recording.service", () => ({
        playableRecordingUrl: async (c: { call_id: number }) => ({ url: `https://signed.example/${c.call_id}.wav` }),
      }));
      const { tables } = await import("@/db");
      const { app } = await import("@/app");
      // Never write anywhere but the throwaway database.
      expect(tables.AuditResult.sequelize!.getDatabaseName()).toBe(name);
      expect(name.startsWith(TEST_DB_PREFIX)).toBe(true);
      expect(env.AUDIT_V2_ENABLED).toBe(false);

      const call = {
        source: "voice_call_logs",
        call_id: SOURCE_ROW.id,
        business_id: 7,
        agent_id: 1,
        call: { call_id: SOURCE_ROW.id } as any,
      };
      const v1 = await tables.AuditResult.create({
        ...call,
        rubric_version: "hansa-v3",
        status: "completed",
        overall_score: 82,
        success_result: "PASS",
        goal_result: "ACHIEVED",
        failure_codes: [],
        call_created_at: new Date(SOURCE_ROW.created_at),
      });
      await sequelize.query("UPDATE audit_results SET created_at = :t, updated_at = :t, audited_at = :t", {
        replacements: { t: AUDITED_AT },
      });

      const GETS = [
        "/calls",
        "/calls?sort=score_desc",
        "/calls?audit=audited",
        "/calls?audit=not_audited",
        "/calls?success=PASS",
        "/calls/stats",
        `/calls/${SOURCE_ROW.id}`,
        `/calls/${SOURCE_ROW.id}/recording`,
        "/calls/999999",
        "/audits",
        "/audits/stats",
        `/audits/${v1.id}`,
        `/audits/${v1.id}/recording`,
        "/audits/999999",
        "/agents",
      ];
      const snapshot = async () => {
        const out: Record<string, { status: number; body: unknown }> = {};
        for (const path of GETS) {
          const res = await app.request(`/v1/audit${path}`, { headers: auth });
          out[path] = { status: res.status, body: await res.json() };
        }
        return out;
      };

      const before = await snapshot();
      expect(before).toMatchSnapshot();
      expect((before[`/calls/${SOURCE_ROW.id}`].body as any).data.audit.id).toBe(v1.id);
      expect((before["/audits"].body as any).total).toBe(1);
      expect(await (await app.request("/v1/audit/config", { headers: auth })).json()).toEqual({ data: { v2_enabled: false } });
      const unauthorized = await app.request("/v1/audit/calls");
      expect({ status: unauthorized.status, body: await unauthorized.json() }).toMatchSnapshot();

      // Newer than the v1 row, with different outcomes, so any leak would change a response.
      const v2 = await tables.AuditResult.create({
        ...call,
        engine: "v2",
        rubric_version: "hansa@v2-1",
        status: "completed",
        overall_score: 12,
        success_result: "FAIL",
        goal_result: "NOT_ACHIEVED",
        failure_codes: ["V2_ONLY"],
        needs_review: true,
        call_created_at: new Date(SOURCE_ROW.created_at),
      });

      const get = (path: string, init: RequestInit = {}) => app.request(`/v1/audit${path}`, { ...init, headers: auth });
      expect(await snapshot()).toEqual(before);
      expect(((await (await get("/calls?failure_code=V2_ONLY")).json()) as any).total).toBe(0);
      expect((await get(`/audits/${v2.id}`)).status).toBe(404);
      expect((await get(`/audits/${v2.id}/recording`)).status).toBe(404);
      expect((await get(`/audits/${v2.id}/reaudit`, { method: "POST" })).status).toBe(404);

      // runAudit (Audit this call, replay) writes a v1 row and leaves the v2 audit alone. A call that never connected is
      // skipped before the agent-prompt RPC and the judge, so nothing leaves the process.
      const { runAudit } = await import("@/audit/run-audit");
      const { normalizeCall } = await import("@/audit/normalize");
      const skippedCall = normalizeCall({ ...SOURCE_ROW, id: SOURCE_ROW.id + 1, status: "failed" });
      const v2Before = (await tables.AuditResult.findByPk(v2.id, { raw: true }))!;
      const written = await runAudit(skippedCall);
      expect(written).toMatchObject({ engine: "v1", status: "skipped", call_id: SOURCE_ROW.id + 1 });
      await tables.AuditResult.create({
        ...call,
        call_id: SOURCE_ROW.id + 1,
        engine: "v2",
        rubric_version: "hansa@v2-1",
        status: "completed",
      });
      expect((await runAudit(skippedCall)).id).toBe(written.id);
      expect(await tables.AuditResult.findByPk(v2.id, { raw: true })).toEqual(v2Before);

      // POST "Audit this call" and "Re-audit" return the row as before v2: its v1 columns and engine, no v2 fields.
      const { V2_FIELDS } = await import("@/db/models/audit-result");
      const v1Keys = Object.keys(tables.AuditResult.getAttributes())
        .filter((k) => !(V2_FIELDS as readonly string[]).includes(k))
        .sort();
      expect(v1Keys).toHaveLength(29); // the 28 baseline columns + engine
      const audited = await get(`/calls/${NO_ANSWER_ROW.id}/audit`, { method: "POST" });
      const auditedRow = ((await audited.json()) as any).data;
      expect([audited.status, auditedRow.status, Object.keys(auditedRow).sort()]).toEqual([200, "skipped", v1Keys]);
      const reaudited = ((await (await get(`/audits/${auditedRow.id}/reaudit`, { method: "POST" })).json()) as any).data;
      expect([reaudited.id, Object.keys(reaudited).sort()]).toEqual([auditedRow.id, v1Keys]);
    }));
});

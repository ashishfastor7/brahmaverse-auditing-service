import { describe, expect, it } from "bun:test";
import { cases, plantedRow } from "../../../fixtures/planted/cases";
import type { Judge } from "@/audit/audit-call";
import { fixtureJudge } from "@/audit/judge/fixture-judge";
import { createMigrator } from "@/db/migrator";
import { rescoreAudit } from "@/db/rescore";
import { dbTestsEnabled, withTestDb } from "@/db/test-db";
import { auditV2Router } from "@/routes/audit-v2";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { QueryTypes, type Sequelize } from "sequelize";
import { ZodError } from "zod";
import { AuditRequestError, runAuditV2 } from "./run-audit";

const MODEL = "gpt-5.4-mini-2026-03-17";
const loopRow = () => plantedRow(cases.find((c) => c.name === "agent-loop")!, 4242);
const run = (sequelize: Sequelize, opts: { force?: boolean; judge?: Judge; weights?: Record<string, number>; row?: any } = {}) =>
  runAuditV2(sequelize, opts.row ?? loopRow(), {
    judge: { judge: opts.judge ?? fixtureJudge("hansa-agent-loop", "v2"), model: MODEL },
    force: opts.force,
    weights: opts.weights,
    triggeredBy: "admin",
    triggerMode: "single",
  });
const count = async (sequelize: Sequelize, table: string, id: number) =>
  (await sequelize.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE audit_id = $1`, { bind: [id], type: QueryTypes.SELECT }))[0]!.n;
const audits = (sequelize: Sequelize) =>
  sequelize.query<{ id: number; status: string; superseded_by: number | null }>(
    "SELECT id, status, superseded_by FROM audit_results WHERE engine = 'v2' ORDER BY id",
    { type: QueryTypes.SELECT },
  );

describe.skipIf(!dbTestsEnabled)("runAuditV2 (P1-8)", () => {
  it("stores a v2 audit with its checks, metric results and flags; re-scoring with its weights gives its score", () =>
    withTestDb(async (sequelize) => {
      await createMigrator(sequelize, { quiet: true }).up();
      const row = await run(sequelize);
      expect(row).toMatchObject({
        status: "completed",
        system_goal: "FAIL",
        business_goal: "ACHIEVED",
        business_reason: "SCREENING_COMPLETED",
        success_result: "PASS",
        judge_model: MODEL,
        judge_prompt_version: "v2-1",
        superseded_by: null,
      });
      const [stored] = await sequelize.query<any>(
        "SELECT engine, rubric_version, scorecard_id, scorecard_version, goal_version, trigger_mode, triggered_by, failure_codes FROM audit_results WHERE id = $1",
        { bind: [row.id], type: QueryTypes.SELECT },
      );
      expect(stored).toEqual({
        engine: "v2",
        rubric_version: "v2:hansa@4",
        scorecard_id: "hansa",
        scorecard_version: 4,
        goal_version: 1,
        trigger_mode: "single",
        triggered_by: "admin",
        failure_codes: ["AGENT_LOOP"],
      });
      expect([await count(sequelize, "audit_check", row.id), await count(sequelize, "metric_result", row.id), await count(sequelize, "failure_flag", row.id)]).toEqual([
        4, 10, 1,
      ]);
      const weights = row.result!.weights_used;
      expect((await rescoreAudit(sequelize, row.id, weights))!.score).toBe(row.score);
    }));

  it("is idempotent without force; a forced re-audit adds a row and supersedes the old one; a failed one leaves it current", () =>
    withTestDb(async (sequelize) => {
      await createMigrator(sequelize, { quiet: true }).up();
      const first = await run(sequelize);
      expect((await run(sequelize)).id).toBe(first.id);

      const second = await run(sequelize, { force: true });
      expect(second.id).not.toBe(first.id);
      expect(await audits(sequelize)).toEqual([
        { id: first.id, status: "completed", superseded_by: second.id },
        { id: second.id, status: "completed", superseded_by: null },
      ]);

      const broken: Judge = async () => {
        throw new Error("judge down");
      };
      const error = await run(sequelize, { force: true, judge: broken }).then(
        () => null,
        (e: Error) => e.message,
      );
      expect(error).toBe("judge down");
      const after = await audits(sequelize);
      expect(after.at(-1)).toMatchObject({ status: "failed", superseded_by: null });
      expect(after[1]).toEqual({ id: second.id, status: "completed", superseded_by: null });

      // different weights are a different audit, even without force
      const weights = { ...second.result!.weights_used, troubleshooting: 0, flow_adherence: 20 };
      const reweighted = await run(sequelize, { weights });
      expect(reweighted.id).not.toBe(second.id);
      expect(reweighted.result!.metrics.map((m) => m.key)).not.toContain("troubleshooting");
    }));

  it("stores a call it can't audit as skipped, superseding nothing; refuses weights it can't use", () =>
    withTestDb(async (sequelize) => {
      await createMigrator(sequelize, { quiet: true }).up();
      const done = await run(sequelize);
      const skipped = await run(sequelize, { row: { ...loopRow(), status: "no_answer" } });
      expect(skipped).toMatchObject({ status: "skipped", skip_reason: "NOT_COMPLETED" });
      expect((await audits(sequelize)).find((a) => a.id === done.id)?.superseded_by).toBeNull();

      const error = await run(sequelize, { weights: { repetition: 50 } }).then(
        () => null,
        (e: Error) => e,
      );
      expect(error).toBeInstanceOf(AuditRequestError);
      expect(error!.message).toBe("weights can't be used: weights total 50, not 100");
    }));

  it("POST /v2/calls/:id/audit: 404 with v2 off or an unknown call; 400 for weights it can't use", () =>
    withTestDb(async (sequelize) => {
      await createMigrator(sequelize, { quiet: true }).up();
      let v2 = false;
      const app = new Hono().route(
        "/v1/audit",
        auditV2Router(
          () => sequelize,
          () => v2,
          async (id) => (id === 4242 ? loopRow() : null),
        ),
      );
      // As in app.ts.
      app.onError((err, c) =>
        c.json({ message: err.message }, err instanceof HTTPException ? err.status : err instanceof ZodError ? 400 : 500),
      );
      const post = async (path: string, body: unknown) => {
        const res = await app.request(`/v1/audit${path}`, { method: "POST", body: JSON.stringify(body) });
        return { status: res.status, body: (await res.json()) as any };
      };
      expect((await post("/v2/calls/4242/audit", {})).status).toBe(404);
      v2 = true;
      expect((await post("/v2/calls/1/audit", {})).status).toBe(404);
      expect(await post("/v2/calls/4242/audit", { weights: { repetition: 50 } })).toEqual({
        status: 400,
        body: { message: "weights can't be used: weights total 50, not 100" },
      });
      expect((await post("/v2/calls/4242/audit", { weights: { repetition: "lots" } })).status).toBe(400);
      expect(await sequelize.query("SELECT 1 FROM audit_results", { type: QueryTypes.SELECT })).toEqual([]);
    }));

  it("POST /v2/calls/:id/audit: 200 with the stored audit, triggered by the shared login; 502 when the judge fails", () =>
    withTestDb(async (sequelize) => {
      await createMigrator(sequelize, { quiet: true }).up();
      let judge: Judge = fixtureJudge("hansa-agent-loop", "v2");
      const app = new Hono().route(
        "/v1/audit",
        auditV2Router(
          () => sequelize,
          () => true,
          async () => loopRow(),
          { judge: (call) => judge(call), model: MODEL },
        ),
      );
      app.onError((err, c) => c.json({ message: err.message }, err instanceof HTTPException ? err.status : 500));
      const res = await app.request("/v1/audit/v2/calls/4242/audit", { method: "POST", body: "{}" });
      const body = (await res.json()) as any;
      expect([res.status, body.data.status, body.data.system_goal, body.data.business_goal]).toEqual([200, "completed", "FAIL", "ACHIEVED"]);
      const [stored] = await sequelize.query<any>("SELECT triggered_by, trigger_mode FROM audit_results WHERE id = $1", {
        bind: [body.data.id],
        type: QueryTypes.SELECT,
      });
      expect(stored).toEqual({ triggered_by: "admin", trigger_mode: "single" });

      judge = async () => {
        throw new Error("judge down");
      };
      const failed = await app.request("/v1/audit/v2/calls/4242/audit", { method: "POST", body: "{}" });
      expect([failed.status, ((await failed.json()) as any).message]).toEqual([502, "Audit failed: judge down"]);
    }));

  it("stores the judge's cost; a call whose agent has no v2 config is skipped with the reason", () =>
    withTestDb(async (sequelize) => {
      await createMigrator(sequelize, { quiet: true }).up();
      const row = await run(sequelize);
      expect(row.result!.judge.attempts).toHaveLength(1); // one answer, no retry
      expect(row.cost).toBeGreaterThan(0); // the recorded answer's tokens at gpt-5.4-mini's price

      const unknown = await run(sequelize, { row: { ...loopRow(), id: 4243, agent_id: 999, agent_code: null } });
      expect(unknown).toMatchObject({ status: "skipped", skip_reason: "UNKNOWN_AGENT" });
    }));
});

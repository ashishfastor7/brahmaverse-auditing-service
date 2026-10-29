import { rescoreRouter } from "@/routes/rescore";
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { QueryTypes, type Sequelize } from "sequelize";
import { ZodError } from "zod";
import { createMigrator } from "./migrator";
import { rescoreAudit, saveRescore } from "./rescore";
import { dbTestsEnabled, withTestDb } from "./test-db";
import type { AuthEnv } from "@/middleware/auth";

/** The routers read the signed-in user that the app's session middleware sets; here it's always "admin". */
const signedIn = () =>
  new Hono<AuthEnv>().use(async (c, next) => {
    c.set("username", "admin");
    await next();
  });

/** The error message, or null if it worked. (Bun 1.2's `expect(...).rejects` hangs on Sequelize errors.) */
const failure = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: Error) => e.message,
  );

const ALL_TEN = {
  flow_adherence: 10,
  query_handling: 10,
  troubleshooting: 10,
  communication_tone: 10,
  opening_closure: 10,
  language_match: 10,
  repetition: 10,
  stalling_filler: 10,
  interruptions: 10,
  pronunciation_numbers: 10,
};

/** A v2 audit on `default` v2 with raw metric scores; `AGENT_LOOP` (Major) zeroes repetition. Scores 70.0 at 10 each. */
async function seedAudit(sequelize: Sequelize) {
  const one = async <T extends object>(sql: string) => (await sequelize.query<T>(sql, { type: QueryTypes.SELECT }))[0]!;
  const { id } = await one<{ id: number }>(
    `INSERT INTO audit_results (engine, source, call_id, business_id, agent_code, rubric_version, status, call, score,
       scorecard_id, scorecard_version, weights_used)
     VALUES ('v2', 'voice_call_logs', 1, 7, 'caller', 'default@2', 'completed', '{}', 70.0, 'default', 2, '${JSON.stringify(ALL_TEN)}')
     RETURNING id`,
  );
  const scores: Record<string, number | null> = {
    flow_adherence: 8,
    query_handling: 6,
    troubleshooting: null,
    communication_tone: 9,
    opening_closure: 7,
    language_match: 10,
    repetition: 7,
    stalling_filler: 9,
    interruptions: null,
    pronunciation_numbers: null,
  };
  for (const [key, score] of Object.entries(scores)) {
    await sequelize.query(
      `INSERT INTO metric_result (audit_id, metric_id, score, max, n_a)
       SELECT $1::int, id, $2::numeric, 10, $3::boolean FROM metric WHERE scorecard_id = 'default' AND scorecard_version = 2 AND key = $4`,
      { bind: [id, score, score === null, key] },
    );
  }
  await sequelize.query(
    `INSERT INTO failure_flag (audit_id, condition_code, severity, source, evidence) VALUES ($1, 'AGENT_LOOP', 'major', 'judge', '[{"turns": [3, 5, 7]}]')`,
    { bind: [id] },
  );
  return id;
}

describe.skipIf(!dbTestsEnabled)("re-scores (P1-9)", () => {
  it("re-scores from stored metric results with new weights, without writing anything", () =>
    withTestDb(async (sequelize) => {
      await createMigrator(sequelize, { quiet: true }).up();
      const id = await seedAudit(sequelize);
      const [stored] = await sequelize.query<{ score: number; weights_used: Record<string, number> }>(
        `SELECT score::float8 AS score, weights_used FROM audit_results WHERE id = ${id}`,
        { type: QueryTypes.SELECT },
      );

      // The weights it was audited with give back its score: (8 + 6 + 9 + 7 + 10 + 0 + 9) / 70, repetition zeroed by the loop.
      expect(await rescoreAudit(sequelize, id, stored!.weights_used)).toEqual({
        score: stored!.score,
        passed: true,
        failedBy: [],
        weights: ALL_TEN,
      });

      // Flow 40, opening and stalling 0: (40·0.8 + 10·0.6 + 10·0.9 + 10·1 + 10·0) / 80 = 71.25.
      const weights = {
        ...ALL_TEN,
        flow_adherence: 40,
        opening_closure: 0,
        stalling_filler: 0,
        interruptions: 5,
        pronunciation_numbers: 5,
      };
      expect((await rescoreAudit(sequelize, id, weights))?.score).toBe(71.3);

      const [after] = await sequelize.query(`SELECT score::float8 AS score, weights_used FROM audit_results WHERE id = ${id}`, {
        type: QueryTypes.SELECT,
      });
      expect(after).toEqual(stored!);
    }));

  it("a Critical flag still fails the call whatever the weights", () =>
    withTestDb(async (sequelize) => {
      await createMigrator(sequelize, { quiet: true }).up();
      const id = await seedAudit(sequelize);
      await sequelize.query(
        `INSERT INTO failure_flag (audit_id, condition_code, severity, source, evidence)
         VALUES ($1, 'CRITICAL_HALLUCINATION', 'critical', 'judge', '[{"turns": [4]}]')`,
        { bind: [id] },
      );
      expect(await rescoreAudit(sequelize, id, ALL_TEN)).toMatchObject({
        score: 70,
        passed: false,
        failedBy: [{ kind: "critical", code: "CRITICAL_HALLUCINATION" }],
      });
    }));

  it("returns null for a missing or v1 audit; refuses an unfinished audit and weights it can't use", () =>
    withTestDb(async (sequelize) => {
      await createMigrator(sequelize, { quiet: true }).up();
      const id = await seedAudit(sequelize);
      expect(await rescoreAudit(sequelize, id + 100, ALL_TEN)).toBeNull();
      await sequelize.query("UPDATE audit_results SET engine = 'v1' WHERE id = $1", { bind: [id] });
      expect(await rescoreAudit(sequelize, id, ALL_TEN)).toBeNull();
      await sequelize.query("UPDATE audit_results SET engine = 'v2' WHERE id = $1", { bind: [id] });

      expect(await failure(rescoreAudit(sequelize, id, { ...ALL_TEN, repetition: 0 }))).toContain("weights total 90, not 100");
      expect(await failure(rescoreAudit(sequelize, id, { ...ALL_TEN, repetition: 0, made_up: 10 }))).toContain("unknown metric made_up");
      expect(await failure(rescoreAudit(sequelize, id, { ...ALL_TEN, repetition: -10, flow_adherence: 30 }))).toContain(
        "repetition has a negative weight",
      );
      expect(await failure(rescoreAudit(sequelize, id, { ...ALL_TEN, flow_adherence: 10.05, query_handling: 9.95 }))).toContain(
        "flow_adherence has more than one decimal",
      );

      // All the weight on N/A metrics: nothing to score, so the call fails.
      const onlyNa = { troubleshooting: 50, interruptions: 50 };
      expect(await rescoreAudit(sequelize, id, onlyNa)).toEqual({
        score: null,
        passed: false,
        failedBy: [{ kind: "no_score" }],
        weights: onlyNa,
      });

      // A metric at weight 0 when audited has no result (the judge skipped it): weighting it needs a re-audit.
      await sequelize.query(
        `DELETE FROM metric_result WHERE audit_id = $1 AND metric_id = (SELECT id FROM metric WHERE scorecard_id = 'default'
           AND scorecard_version = 2 AND key = 'stalling_filler')`,
        { bind: [id] },
      );
      expect(await failure(rescoreAudit(sequelize, id, ALL_TEN))).toContain(
        "stalling_filler weren't scored in this audit (weight 0 when audited); re-audit to weight them",
      );
      // (20·0.8 + 6 + 9 + 7 + 10 + 0) / 70 = 68.6
      expect((await rescoreAudit(sequelize, id, { ...ALL_TEN, stalling_filler: 0, flow_adherence: 20 }))?.score).toBe(68.6);

      await sequelize.query("UPDATE audit_results SET status = 'failed' WHERE id = $1", { bind: [id] });
      expect(await failure(rescoreAudit(sequelize, id, ALL_TEN))).toContain(
        `audit ${id} is failed; only completed audits can be re-scored`,
      );
    }));

  it("saveRescore adds to the audit's re-score history and leaves the audit row as audited", () =>
    withTestDb(async (sequelize) => {
      await createMigrator(sequelize, { quiet: true }).up();
      const id = await seedAudit(sequelize);
      const auditRow = () => sequelize.query(`SELECT * FROM audit_results WHERE id = ${id}`, { type: QueryTypes.SELECT });
      const before = await auditRow();

      const first = await saveRescore(
        sequelize,
        id,
        { ...ALL_TEN, flow_adherence: 40, opening_closure: 0, stalling_filler: 0, interruptions: 5, pronunciation_numbers: 5 },
        "admin",
      );
      expect(first).toMatchObject({ audit_id: id, score: 71.3, passed: true, failedBy: [], created_by: "admin" });
      const second = await saveRescore(sequelize, id, ALL_TEN, "admin");
      expect(second?.score).toBe(70);
      expect(
        await sequelize.query(`SELECT id, score::float8 AS score, weights_used FROM audit_rescore WHERE audit_id = ${id} ORDER BY id`, {
          type: QueryTypes.SELECT,
        }),
      ).toEqual([
        { id: first!.id, score: 71.3, weights_used: first!.weights_used },
        { id: second!.id, score: 70, weights_used: ALL_TEN },
      ]);
      expect(await auditRow()).toEqual(before);

      // No score is stored as null; scores outside 0–100 are refused.
      const none = await saveRescore(sequelize, id, { troubleshooting: 50, interruptions: 50 }, "admin");
      expect([none?.score, none?.passed]).toEqual([null, false]);
      expect(
        await failure(
          sequelize.query(
            `INSERT INTO audit_rescore (audit_id, weights_used, score, passed, created_by) VALUES (${id}, '{}', 100.1, true, 'admin')`,
          ),
        ),
      ).toContain("audit_rescore_score_check");
      expect(await failure(sequelize.query(`UPDATE audit_results SET score = 100.1 WHERE id = ${id}`))).toContain(
        "audit_results_score_check",
      );

      expect(await saveRescore(sequelize, id + 100, ALL_TEN, "admin")).toBeNull();
      // Re-scores go with their audit.
      await sequelize.query(`DELETE FROM audit_results WHERE id = ${id}`);
      expect(await sequelize.query("SELECT 1 FROM audit_rescore", { type: QueryTypes.SELECT })).toEqual([]);
    }));

  it("POST /audits/:id/rescore: saves and returns the re-score; 404 with v2 off or for a v1 audit; 409 unfinished; 400 bad input", () =>
    withTestDb(async (sequelize) => {
      await createMigrator(sequelize, { quiet: true }).up();
      const id = await seedAudit(sequelize);
      let v2 = true;
      const app = signedIn().route(
        "/v1/audit",
        rescoreRouter(
          () => sequelize,
          () => v2,
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

      const ok = await post(`/audits/${id}/rescore`, { weights: { ...ALL_TEN, repetition: 30, stalling_filler: 0, troubleshooting: 0 } });
      // (8 + 6 + 9 + 7 + 10 + 30·0) / 80 with repetition still zeroed by the loop = 50.0
      expect([ok.status, ok.body.data.score, ok.body.data.passed, ok.body.data.created_by]).toEqual([200, 50, true, "admin"]);

      expect((await post(`/audits/${id}/rescore`, { weights: { ...ALL_TEN, repetition: 0 } })).body).toEqual({
        message: "weights total 90, not 100",
      });
      expect((await post(`/audits/${id}/rescore`, { weights: { ...ALL_TEN, repetition: 0 } })).status).toBe(400);
      expect((await post(`/audits/${id}/rescore`, {})).status).toBe(400);
      expect((await post(`/audits/${id}/rescore`, { weights: { flow_adherence: "a lot" } })).status).toBe(400);
      expect((await app.request(`/v1/audit/audits/${id}/rescore`, { method: "POST", body: "{not json" })).status).toBe(400);
      expect((await post(`/audits/${id + 100}/rescore`, { weights: ALL_TEN })).status).toBe(404);
      expect((await post("/audits/abc/rescore", { weights: ALL_TEN })).status).toBe(404);
      await sequelize.query("UPDATE audit_results SET engine = 'v1' WHERE id = $1", { bind: [id] });
      expect((await post(`/audits/${id}/rescore`, { weights: ALL_TEN })).status).toBe(404);
      await sequelize.query("UPDATE audit_results SET engine = 'v2', status = 'pending' WHERE id = $1", { bind: [id] });
      expect((await post(`/audits/${id}/rescore`, { weights: ALL_TEN })).status).toBe(409);
      await sequelize.query("UPDATE audit_results SET status = 'completed' WHERE id = $1", { bind: [id] });

      v2 = false;
      expect((await post(`/audits/${id}/rescore`, { weights: ALL_TEN })).status).toBe(404);
      expect(await sequelize.query(`SELECT 1 FROM audit_rescore WHERE audit_id = ${id}`, { type: QueryTypes.SELECT })).toHaveLength(1);
    }));
});

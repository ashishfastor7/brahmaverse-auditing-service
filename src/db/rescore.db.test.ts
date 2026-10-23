import { describe, expect, it } from "bun:test";
import { QueryTypes, type Sequelize } from "sequelize";
import { createMigrator } from "./migrator";
import { rescoreAudit } from "./rescore";
import { dbTestsEnabled, withTestDb } from "./test-db";

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
    `INSERT INTO audit_results (engine, source, call_id, business_id, agent_code, rubric_version, status, call, overall_score,
       scorecard_id, scorecard_version, weights_used)
     VALUES ('v2', 'voice_call_logs', 1, 7, 'caller', 'default@2', 'completed', '{}', 70, 'default', 2, '${JSON.stringify(ALL_TEN)}')
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

describe.skipIf(!dbTestsEnabled)("rescoreAudit (P1-9, compute only)", () => {
  it("re-scores from stored metric results with new weights, without writing anything", () =>
    withTestDb(async (sequelize) => {
      await createMigrator(sequelize, { quiet: true }).up();
      const id = await seedAudit(sequelize);
      const [stored] = await sequelize.query<{ overall_score: number; weights_used: Record<string, number> }>(
        `SELECT overall_score, weights_used FROM audit_results WHERE id = ${id}`,
        { type: QueryTypes.SELECT },
      );

      // The weights it was audited with give back its score: (8 + 6 + 9 + 7 + 10 + 0 + 9) / 70, repetition zeroed by the loop.
      expect(await rescoreAudit(sequelize, id, stored!.weights_used)).toEqual({
        score: stored!.overall_score,
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

      const [after] = await sequelize.query(`SELECT overall_score, weights_used FROM audit_results WHERE id = ${id}`, {
        type: QueryTypes.SELECT,
      });
      expect(after).toEqual(stored!);
    }));

  it("a Critical flag still fails the call whatever the weights", () =>
    withTestDb(async (sequelize) => {
      await createMigrator(sequelize, { quiet: true }).up();
      const id = await seedAudit(sequelize);
      await sequelize.query(
        `INSERT INTO failure_flag (audit_id, condition_code, severity, source) VALUES ($1, 'CRITICAL_HALLUCINATION', 'critical', 'judge')`,
        { bind: [id] },
      );
      expect(await rescoreAudit(sequelize, id, ALL_TEN)).toMatchObject({
        score: 70,
        passed: false,
        failedBy: [{ kind: "critical", code: "CRITICAL_HALLUCINATION" }],
      });
    }));

  it("returns null for a missing or v1 audit, and refuses weights that don't fit the scorecard", () =>
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
    }));
});

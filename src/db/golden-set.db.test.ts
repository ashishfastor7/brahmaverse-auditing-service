import { describe, expect, it } from "bun:test";
import { QueryTypes, type Sequelize } from "sequelize";
import { createGoalDraft, createScorecardDraft, loadActiveConfig, loadDraftConfig } from "./config-store";
import { loadGoldenSet } from "./golden-set";
import { createMigrator } from "./migrator";
import { dbTestsEnabled, withTestDb } from "./test-db";

const one = async <T extends object>(db: Sequelize, sql: string) => (await db.query<T>(sql, { type: QueryTypes.SELECT }))[0]!;
const refused = (db: Sequelize, sql: string) =>
  db.query(sql).then(
    () => null,
    (e: any) => e.original?.constraint ?? e.message,
  );

async function audit(db: Sequelize, callId: number, engine = "v2") {
  const { id } = await one<{ id: number }>(
    db,
    `INSERT INTO audit_results (engine, source, call_id, business_id, rubric_version, call, result)
     VALUES ('${engine}', 'db', ${callId}, 1, '${engine}-${Math.random()}', '{}', '{"engine": "${engine}"}') RETURNING id`,
  );
  return id;
}
const review = (db: Sequelize, auditId: number, sql: { cols?: string; vals?: string; verdict?: string; at: string }) =>
  db.query(
    `INSERT INTO review (audit_id, reviewer, verdict, created_at${sql.cols ? `, ${sql.cols}` : ""})
     VALUES (${auditId}, 'admin', '${sql.verdict ?? "agree"}', '${sql.at}'${sql.vals ? `, ${sql.vals}` : ""})`,
  );

describe.skipIf(!dbTestsEnabled)("golden set (P1-19, migration 0013)", () => {
  it("is the latest agree / dispute per call with in_golden_set, on v2 audits only", () =>
    withTestDb(async (db) => {
      await createMigrator(db, { quiet: true }).up();
      // call 1: an old agree, then a newer dispute on a re-audit → the dispute
      const a1 = await audit(db, 1);
      const a1b = await audit(db, 1);
      await review(db, a1, { at: "2026-10-01" });
      await review(db, a1b, {
        verdict: "dispute",
        at: "2026-10-02",
        cols: "expected_failure_codes, corrected_scores, corrected_checks",
        vals: `'{AGENT_LOOP}', '{"repetition": 3}', '{"S2": "FAIL"}'`,
      });
      // call 2: a blind check, then a flag (flags don't count)
      const a2 = await audit(db, 2);
      await review(db, a2, {
        at: "2026-10-03",
        cols: "kind, expected_pass_fail, expected_business_outcome, expected_failure_codes",
        vals: `'blind', 'PASS', 'ACHIEVED', '{}'`,
      });
      await review(db, a2, { verdict: "flag", at: "2026-10-05" });
      // call 3: its latest review was retired → the call is out, the older one doesn't come back
      const a3 = await audit(db, 3);
      await review(db, a3, { at: "2026-10-01" });
      await review(db, a3, { at: "2026-10-04", cols: "in_golden_set", vals: "false" });
      // call 4: a v1 audit's review
      await review(db, await audit(db, 4, "v1"), { at: "2026-10-01" });

      const rows = await loadGoldenSet(db);
      expect(rows.map((r) => [r.call_id, r.kind, r.verdict])).toEqual([
        [1, "normal", "dispute"],
        [2, "blind", "agree"],
      ]);
      expect(rows[0]).toMatchObject({
        audit_id: a1b,
        expected_failure_codes: ["AGENT_LOOP"],
        corrected_scores: { repetition: 3 },
        corrected_checks: { S2: "FAIL" },
        expected_pass_fail: null,
        in_golden_set: true,
        created_at: new Date("2026-10-02").toISOString(),
        audit: { engine: "v2" },
      });
      expect(rows[1]).toMatchObject({ expected_pass_fail: "PASS", expected_business_outcome: "ACHIEVED", expected_failure_codes: [] });
    }));

  it("refuses bad kinds, outcomes and a blind review without its answers; down removes the columns", () =>
    withTestDb(async (db) => {
      const migrator = createMigrator(db, { quiet: true });
      await migrator.up();
      const a = await audit(db, 1);
      const insert = (cols: string, vals: string) =>
        `INSERT INTO review (audit_id, reviewer, verdict, ${cols}) VALUES (${a}, 'admin', 'agree', ${vals})`;
      expect(await refused(db, insert("kind", "'secret'"))).toBe("review_kind_check");
      expect(await refused(db, insert("expected_pass_fail", "'MAYBE'"))).toBe("review_expected_pass_fail_check");
      expect(await refused(db, insert("expected_business_outcome", "'DONE'"))).toBe("review_expected_business_outcome_check");
      expect(await refused(db, insert("corrected_checks", `'["S2"]'`))).toBe("review_corrected_checks_check");
      expect(await refused(db, insert("kind, expected_pass_fail", "'blind', 'PASS'"))).toBe("review_blind_answers_check");

      await migrator.down({ to: "0013-review-golden-set" });
      const columns = await db.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'review' ORDER BY ordinal_position",
        { type: QueryTypes.SELECT },
      );
      expect(columns.map((c) => c.column_name)).toEqual([
        "id",
        "audit_id",
        "reviewer",
        "verdict",
        "corrected_scores",
        "note",
        "created_at",
      ]);
    }));
});

describe.skipIf(!dbTestsEnabled)("eval:v2 --draft config", () => {
  it("is the published config until the agent has drafts, then its scorecard draft and goal draft", () =>
    withTestDb(async (db) => {
      await createMigrator(db, { quiet: true }).up();
      expect(await loadDraftConfig(db, "hrms", null)).toEqual(await loadActiveConfig(db, "hrms", null));

      await createScorecardDraft(db, "hansa", "admin");
      await createGoalDraft(db, "hrms", "admin");
      const draft = await loadDraftConfig(db, "hrms", null);
      expect([draft.scorecard?.scorecard_id, draft.scorecard?.version, draft.scorecard?.status]).toEqual(["hansa", 5, "draft"]);
      expect([draft.goal?.version, draft.goal?.status]).toEqual([2, "draft"]);
      // other agents and real audits still get the published config
      expect((await loadDraftConfig(db, "caller", null)).scorecard?.version).toBe(4);
      expect((await loadActiveConfig(db, "hrms", null)).scorecard?.version).toBe(4);
    }));
});

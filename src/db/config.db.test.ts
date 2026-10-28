import { describe, expect, it } from "bun:test";
import { QueryTypes, type Sequelize } from "sequelize";
import {
  assignScorecard,
  createGoalDraft,
  createScorecardDraft,
  loadActiveConfig,
  loadScorecard,
  publishGoalConfig,
  publishScorecard,
} from "./config-store";
import { createMigrator } from "./migrator";
import { dbTestsEnabled, withTestDb } from "./test-db";

const all = <T extends object>(sequelize: Sequelize, sql: string) => sequelize.query<T>(sql, { type: QueryTypes.SELECT });
/** The error message, or null if it worked. (Bun 1.2's `expect(...).rejects` hangs on Sequelize errors.) */
const failure = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: Error) => e.message,
  );

describe.skipIf(!dbTestsEnabled)("v2 config (migrations 0003–0010, config-store)", () => {
  it("seeds the condition library, goal config v1 per agent, the v1 templates and the 10-metric scorecards", () =>
    withTestDb(async (sequelize) => {
      await createMigrator(sequelize, { quiet: true }).up();

      const library = await all<{ code: string; default_severity: string }>(sequelize, "SELECT code, default_severity FROM failure_condition");
      expect(library).toHaveLength(20);
      expect(library.filter((c) => c.default_severity === "minor")).toHaveLength(11);
      expect(await all(sequelize, "SELECT agent_code, version, status FROM goal_config ORDER BY agent_code")).toEqual([
        { agent_code: "caller", version: 1, status: "published" },
        { agent_code: "hrms", version: 1, status: "published" },
        { agent_code: "project-manager", version: 1, status: "published" },
      ]);
      expect(
        await all(
          sequelize,
          `SELECT s.scorecard_id, s.version, s.status, s.based_on, count(m.id)::int AS metrics, sum(m.weight)::float8 AS total
             FROM scorecard s JOIN metric m ON m.scorecard_id = s.scorecard_id AND m.scorecard_version = s.version
            GROUP BY 1, 2, 3, 4 ORDER BY 1, 2`,
        ),
      ).toEqual([
        { scorecard_id: "default", version: 1, status: "published", based_on: null, metrics: 5, total: 100 },
        { scorecard_id: "default", version: 2, status: "published", based_on: 1, metrics: 10, total: 100 },
        { scorecard_id: "default", version: 3, status: "published", based_on: 2, metrics: 10, total: 100 },
        { scorecard_id: "hansa", version: 1, status: "published", based_on: null, metrics: 5, total: 100 },
        { scorecard_id: "hansa", version: 2, status: "published", based_on: 1, metrics: 10, total: 100 },
        { scorecard_id: "hansa", version: 3, status: "published", based_on: 2, metrics: 10, total: 100 },
      ]);
      expect(
        await all(sequelize, "SELECT agent_code, scorecard_id, scorecard_version FROM scorecard_assignment ORDER BY agent_code"),
      ).toEqual([
        { agent_code: "caller", scorecard_id: "default", scorecard_version: 3 },
        { agent_code: "hrms", scorecard_id: "hansa", scorecard_version: 3 },
        { agent_code: "project-manager", scorecard_id: "default", scorecard_version: 3 },
      ]);

      const v2 = (await loadScorecard(sequelize, "default", 2))!;
      expect(v2.metrics.every((m) => m.weight === 10)).toBe(true);
      expect(v2.metrics.filter((m) => m.requires.length).map((m) => [m.key, m.requires])).toEqual([
        ["interruptions", ["timestamps"]],
        ["pronunciation_numbers", ["audio"]],
      ]);
      expect(v2.metrics[0]).toMatchObject({
        key: "flow_adherence",
        position: 1,
        method: "llm",
        scale: 10,
        rubric: { anchors: { 10: expect.any(String) } },
      });
      expect(v2.conditions.find((c) => c.condition_code === "AGENT_LOOP")).toEqual({
        condition_code: "AGENT_LOOP",
        enabled: true,
        severity: "major",
        metric_key: "repetition",
      });

      // v3 (0010): v2 plus the PRD §4.5 proposed conditions, Minor; three disabled until their data exists.
      const v3 = (await loadScorecard(sequelize, "default", 3))!;
      expect(v3.metrics.map(({ id: _, ...m }) => m)).toEqual(v2.metrics.map(({ id: _, ...m }) => m));
      expect(v3.conditions.filter((c) => v2.conditions.some((o) => o.condition_code === c.condition_code))).toEqual(v2.conditions);
      expect(v3.conditions.filter((c) => !c.enabled).map((c) => c.condition_code)).toEqual([
        "FALSE_ACTION_CLAIM",
        "SKIPPED_REQUIRED_STEP",
        "UNRESPONSIVE_AGENT",
      ]);
      expect(v3.conditions.find((c) => c.condition_code === "WRONG_LANGUAGE")).toEqual({
        condition_code: "WRONG_LANGUAGE",
        enabled: true,
        severity: "minor",
        metric_key: "language_match",
      });
      // Hansa: its two extra conditions, and OUTCOME_MISMATCH instead of OUTCOME_MISRECORDED.
      const hansaV3 = (await loadScorecard(sequelize, "hansa", 3))!.conditions.map((c) => c.condition_code);
      expect(v3.conditions.map((c) => c.condition_code)).toContain("OUTCOME_MISRECORDED");
      expect(hansaV3).not.toContain("OUTCOME_MISRECORDED");
      expect(hansaV3).toContain("OUTCOME_MISMATCH");
      expect(hansaV3).toHaveLength(v3.conditions.length + 1);
    }));

  it("0010 down puts the agents back on v2 and removes v3 and the new conditions", () =>
    withTestDb(async (sequelize) => {
      const migrator = createMigrator(sequelize, { quiet: true });
      await migrator.up();
      await migrator.down();
      expect(
        await all(sequelize, "SELECT agent_code, scorecard_id, scorecard_version FROM scorecard_assignment ORDER BY agent_code"),
      ).toEqual([
        { agent_code: "caller", scorecard_id: "default", scorecard_version: 2 },
        { agent_code: "hrms", scorecard_id: "hansa", scorecard_version: 2 },
        { agent_code: "project-manager", scorecard_id: "default", scorecard_version: 2 },
      ]);
      expect(await all(sequelize, "SELECT 1 FROM scorecard WHERE version = 3")).toEqual([]);
      expect(await all(sequelize, "SELECT 1 FROM scorecard_condition WHERE scorecard_version = 3")).toEqual([]);
      expect(await all(sequelize, "SELECT code FROM failure_condition")).toHaveLength(9);
      // The triggers are back on: published versions still can't change.
      expect(await failure(sequelize.query("DELETE FROM scorecard WHERE scorecard_id = 'default' AND version = 2"))).toContain("is published");
    }));

  it("links existing v1 audits to their 5 × 20 template and changes nothing else on them", () =>
    withTestDb(async (sequelize) => {
      const migrator = createMigrator(sequelize, { quiet: true });
      await migrator.up({ to: "0005-audit-batch" });
      await sequelize.query(
        `INSERT INTO audit_results (engine, source, call_id, business_id, agent_code, rubric_version, status, overall_score, success_result, call, created_at, updated_at)
         VALUES ('v1', 'voice_call_logs', 1, 7, 'hrms', 'hansa-v3', 'completed', 72, 'PASS', '{}', '2026-10-01', '2026-10-02'),
                ('v1', 'voice_call_logs', 2, 7, 'caller', 'default-v2', 'completed', 40, 'FAIL', '{}', '2026-10-01', '2026-10-02'),
                ('v1', 'voice_call_logs', 3, 7, NULL, 'hansa@1', 'completed', 55, 'PASS', '{}', '2026-10-01', '2026-10-02'),
                ('v2', 'voice_call_logs', 4, 7, 'caller', 'default-v9', 'completed', 90, 'PASS', '{}', '2026-10-01', '2026-10-02')`,
      );
      const before = await all<Record<string, unknown>>(sequelize, "SELECT * FROM audit_results ORDER BY id");

      await migrator.up();
      const after = await all<Record<string, unknown>>(sequelize, "SELECT * FROM audit_results ORDER BY id");
      expect(after.map((r) => [r.call_id, r.scorecard_id, r.scorecard_version])).toEqual([
        [1, "hansa", 1],
        [2, "default", 1],
        [3, null, null], // unknown rubric version: left unlinked
        [4, null, null], // v2 rows are never touched
      ]);
      const v2Fields = Object.keys(after[0]!).filter((k) => !(k in before[0]!));
      expect(v2Fields).toHaveLength(14); // 0006 adds 13, 0009 adds score
      for (const [i, row] of after.entries()) {
        for (const k of v2Fields.filter((k) => k !== "scorecard_id" && k !== "scorecard_version")) expect(row[k]).toBeNull();
        expect(Object.fromEntries(Object.entries(row).filter(([k]) => !v2Fields.includes(k)))).toEqual(before[i]!);
      }
    }));

  it("published versions can't be changed or deleted, nor a library condition they use", () =>
    withTestDb(async (sequelize) => {
      await createMigrator(sequelize, { quiet: true }).up();
      const q = (sql: string) => failure(sequelize.query(sql));

      expect(
        await q("UPDATE metric SET weight = 20 WHERE scorecard_id = 'default' AND scorecard_version = 2 AND key = 'repetition'"),
      ).toContain("metric of published scorecard default version 2 cannot be changed");
      expect(await q("DELETE FROM metric WHERE scorecard_id = 'hansa'")).toContain("cannot be changed");
      expect(
        await q(
          `INSERT INTO metric (scorecard_id, scorecard_version, key, position, name, rubric, method, weight)
           VALUES ('default', 2, 'extra', 11, 'Extra', '{}', 'llm', 0)`,
        ),
      ).toContain("cannot be changed");
      expect(await q("UPDATE scorecard_condition SET severity = 'minor' WHERE condition_code = 'AGENT_LOOP'")).toContain(
        "cannot be changed",
      );
      expect(await q("UPDATE scorecard SET pass_threshold = 60 WHERE scorecard_id = 'default' AND version = 2")).toContain(
        "scorecard version 2 is published and cannot be changed",
      );
      expect(await q("DELETE FROM scorecard WHERE scorecard_id = 'default' AND version = 1")).toContain("is published");
      expect(await q("UPDATE goal_config SET name = 'x' WHERE agent_code = 'hrms'")).toContain("goal_config version 1 is published");
      expect(await q("UPDATE failure_condition SET definition = 'x' WHERE code = 'AGENT_LOOP'")).toContain("used by a published scorecard");

      const [{ weight }] = await all<{ weight: string }>(
        sequelize,
        "SELECT weight FROM metric WHERE scorecard_version = 2 AND key = 'repetition'",
      );
      expect(weight).toBe("10.0");
    }));

  it("publishing a draft creates a new version; the old one stays exactly as it was", () =>
    withTestDb(async (sequelize) => {
      await createMigrator(sequelize, { quiet: true }).up();
      const v3 = await loadScorecard(sequelize, "default", 3);

      const draft = await createScorecardDraft(sequelize, "default", "admin");
      expect([draft.version, draft.status, draft.based_on, draft.published_at]).toEqual([4, "draft", 3, null]);
      expect(draft.metrics.map(({ id: _, ...m }) => m)).toEqual(v3!.metrics.map(({ id: _, ...m }) => m));
      expect(draft.conditions).toEqual(v3!.conditions);
      expect(await failure(createScorecardDraft(sequelize, "default", "admin"))).toContain("already has a draft (version 4)");

      // A draft can be edited, and is never the active version.
      await sequelize.query(
        "UPDATE metric SET weight = 20 WHERE scorecard_id = 'default' AND scorecard_version = 4 AND key = 'flow_adherence'",
      );
      expect(await failure(publishScorecard(sequelize, "default", "admin"))).toContain("weights total 110, not 100");
      expect((await loadActiveConfig(sequelize, "caller", null)).scorecard?.version).toBe(3);
      await sequelize.query(
        "UPDATE metric SET weight = 0 WHERE scorecard_id = 'default' AND scorecard_version = 4 AND key = 'stalling_filler'",
      );

      const published = await publishScorecard(sequelize, "default", "admin");
      expect([published.version, published.status]).toEqual([4, "published"]);
      expect(published.published_at).toBeInstanceOf(Date);
      expect((await loadActiveConfig(sequelize, "caller", null)).scorecard?.version).toBe(4);
      expect((await loadActiveConfig(sequelize, "project-manager", null)).scorecard?.version).toBe(4);
      expect((await loadActiveConfig(sequelize, "hrms", null)).scorecard).toMatchObject({ scorecard_id: "hansa", version: 3 });
      expect(await loadScorecard(sequelize, "default", 3)).toEqual(v3);
      expect(
        await failure(sequelize.query("UPDATE metric SET weight = 10 WHERE scorecard_version = 4 AND key = 'stalling_filler'")),
      ).toContain("cannot be changed");
      expect(await failure(publishScorecard(sequelize, "default", "admin"))).toContain("has no draft to publish");
      expect(await failure(createScorecardDraft(sequelize, "nope", "admin"))).toContain("no published version");
      // Publishing moved the agents that were on default v3 (Caller and Project manager); Hansa is on its own scorecard.
      expect(
        await all(
          sequelize,
          "SELECT agent_code, scorecard_version, assigned_by FROM scorecard_assignment WHERE scorecard_id = 'default' ORDER BY 1",
        ),
      ).toEqual([
        { agent_code: "caller", scorecard_version: 4, assigned_by: "admin" },
        { agent_code: "project-manager", scorecard_version: 4, assigned_by: "admin" },
      ]);

      const goalDraft = await createGoalDraft(sequelize, "caller", "admin");
      expect([goalDraft.version, goalDraft.status]).toEqual([2, "draft"]);
      expect((await loadActiveConfig(sequelize, "caller", null)).goal?.version).toBe(1);
      await sequelize.query(
        "UPDATE goal_config SET name = 'Book a demo', required_outputs = '{demo_datetime}' WHERE agent_code = 'caller' AND version = 2",
      );
      const goal = await publishGoalConfig(sequelize, "caller");
      expect([goal.version, goal.status, goal.name, goal.required_outputs]).toEqual([2, "published", "Book a demo", ["demo_datetime"]]);
      const active = await loadActiveConfig(sequelize, "caller", null);
      expect([active.goal?.version, active.goal?.name]).toEqual([2, "Book a demo"]);
      expect((await loadActiveConfig(sequelize, "project-manager", null)).goal?.version).toBe(1);
    }));

  it("attaching an agent to a scorecard creates no version and leaves other agents alone", () =>
    withTestDb(async (sequelize) => {
      await createMigrator(sequelize, { quiet: true }).up();
      const versions = () => all(sequelize, "SELECT scorecard_id, version FROM scorecard ORDER BY 1, 2");
      const before = await versions();

      await assignScorecard(sequelize, "hrms", "default", 2, "admin");
      expect(await versions()).toEqual(before);
      expect((await loadActiveConfig(sequelize, "hrms", null)).scorecard).toMatchObject({ scorecard_id: "default", version: 2 });
      expect((await loadActiveConfig(sequelize, "caller", null)).scorecard).toMatchObject({ scorecard_id: "default", version: 3 });
      expect((await loadActiveConfig(sequelize, "project-manager", null)).scorecard).toMatchObject({ scorecard_id: "default", version: 3 });

      // Only published versions with at least 10 metrics (never the 5 × 20), only known agents.
      expect(await failure(assignScorecard(sequelize, "hrms", "hansa", 1, "admin"))).toContain("fewer than 10 metrics");
      expect(await failure(assignScorecard(sequelize, "caller", "default", 1, "admin"))).toContain("fewer than 10 metrics");
      await createScorecardDraft(sequelize, "default", "admin");
      expect(await failure(assignScorecard(sequelize, "project-manager", "default", 4, "admin"))).toContain("is not published");
      expect(await failure(assignScorecard(sequelize, "sales-bot", "default", 2, "admin"))).toContain("unknown agent sales-bot");
      expect((await loadActiveConfig(sequelize, "project-manager", null)).scorecard?.version).toBe(3);
      // A copy of the 5 × 20 can't be published either.
      expect(
        await failure(
          createScorecardDraft(sequelize, "old", "admin", { from: { scorecard_id: "hansa", version: 1 } }).then(() =>
            publishScorecard(sequelize, "old", "admin"),
          ),
        ),
      ).toContain("5 metrics, at least 10 needed");
    }));

  it("a new scorecard or goal config can start from another one (the path for a new agent)", () =>
    withTestDb(async (sequelize) => {
      await createMigrator(sequelize, { quiet: true }).up();

      // A scorecard of its own for Project manager, copied from the Caller's 10 metrics.
      const pmDraft = await createScorecardDraft(sequelize, "project-manager", "admin", { from: { scorecard_id: "default", version: 2 } });
      expect([pmDraft.scorecard_id, pmDraft.version, pmDraft.based_on, pmDraft.metrics.length]).toEqual(["project-manager", 1, null, 10]);
      await publishScorecard(sequelize, "project-manager", "admin");
      // A copy from another scorecard moves nobody: the agent is attached on purpose.
      expect((await loadActiveConfig(sequelize, "caller", null)).scorecard?.scorecard_id).toBe("default");
      expect((await loadActiveConfig(sequelize, "project-manager", null)).scorecard?.scorecard_id).toBe("default");
      await assignScorecard(sequelize, "project-manager", "project-manager", 1, "admin");
      expect((await loadActiveConfig(sequelize, "project-manager", null)).scorecard?.scorecard_id).toBe("project-manager");
      expect(
        await failure(createScorecardDraft(sequelize, "x", "admin", { from: { scorecard_id: "project-manager", version: 9 } })),
      ).toContain("is not published");

      // A goal config copied from another agent's.
      const goalDraft = await createGoalDraft(sequelize, "project-manager", "admin", { from: "hrms" });
      expect([goalDraft.agent_code, goalDraft.version, goalDraft.name]).toEqual(["project-manager", 2, "Recruiting call purpose"]);
      expect(await failure(createGoalDraft(sequelize, "sales-bot", "admin", { from: "caller" }))).toContain("unknown agent sales-bot");
    }));

  it("a draft can be deleted, with its metrics and conditions; publishing a goal draft is validated", () =>
    withTestDb(async (sequelize) => {
      await createMigrator(sequelize, { quiet: true }).up();
      await createScorecardDraft(sequelize, "default", "admin");
      await sequelize.query("DELETE FROM scorecard WHERE scorecard_id = 'default' AND version = 4");
      const parts =
        "SELECT 1 FROM metric WHERE scorecard_version = 4 UNION ALL SELECT 1 FROM scorecard_condition WHERE scorecard_version = 4";
      expect(await all(sequelize, parts)).toEqual([]);
      expect((await createScorecardDraft(sequelize, "default", "admin")).version).toBe(4);

      await createGoalDraft(sequelize, "caller", "admin");
      expect(await failure(createGoalDraft(sequelize, "caller", "admin"))).toContain("already has a draft (version 2)");
      await sequelize.query("UPDATE goal_config SET success_criteria = '{}' WHERE agent_code = 'caller' AND version = 2");
      expect(await failure(publishGoalConfig(sequelize, "caller"))).toContain("no success criteria");
      expect((await loadActiveConfig(sequelize, "caller", null)).goal?.version).toBe(1);
    }));

  it("a v2 audit and its detail rows fit the schema; bad values are refused; details go with the audit", () =>
    withTestDb(async (sequelize) => {
      await createMigrator(sequelize, { quiet: true }).up();
      const q = (sql: string) => sequelize.query(sql);
      const one = async <T extends object>(sql: string) => (await all<T>(sequelize, sql))[0]!;
      const refused = (sql: string) => failure(q(sql));

      const { id: batch } = await one<{ id: number }>(
        `INSERT INTO audit_batch (created_by, trigger_mode, filters, call_count)
         VALUES ('admin', 'sample', '{"agent": "caller", "sample": 20}', 20) RETURNING id`,
      );
      const insertAudit = (superseded_by: number | null = null) =>
        one<{ id: number }>(
          `INSERT INTO audit_results (engine, source, call_id, business_id, agent_code, rubric_version, status, call, triggered_by,
             trigger_mode, batch_id, goal_version, scorecard_id, scorecard_version, weights_used, system_goal, business_goal,
             business_reason, judge_prompt_version, cost, superseded_by)
           VALUES ('v2', 'voice_call_logs', 1, 7, 'caller', 'default@2-${superseded_by ?? 0}', 'completed', '{}', 'admin', 'sample',
             ${batch}, 1, 'default', 2, '{"flow_adherence": 10}', 'PASS', 'PARTIAL', 'CALLBACK_REQUESTED', 'judge-v2-1', 0.0123,
             ${superseded_by ?? "NULL"}) RETURNING id`,
        );
      const metricId = async (key: string) =>
        (await one<{ id: number }>(`SELECT id FROM metric WHERE scorecard_id = 'default' AND scorecard_version = 2 AND key = '${key}'`)).id;
      const { id: audit } = await insertAudit();
      const repetition = await metricId("repetition");
      const interruptions = await metricId("interruptions");
      await q(`INSERT INTO audit_check (audit_id, check_code, result, reason) VALUES (${audit}, 'S1', 'PASS', 'connected')`);
      await q(`INSERT INTO metric_result (audit_id, metric_id, score, max, reason) VALUES (${audit}, ${repetition}, 7, 10, 'one repeat')`);
      await q(`INSERT INTO metric_result (audit_id, metric_id, score, max, n_a) VALUES (${audit}, ${interruptions}, NULL, 10, true)`);
      await q(
        `INSERT INTO failure_flag (audit_id, condition_code, severity, source, evidence)
         VALUES (${audit}, 'AGENT_LOOP', 'major', 'judge', '[{"turns": [3, 5, 7]}]')`,
      );
      await q(
        `INSERT INTO review (audit_id, reviewer, verdict, corrected_scores, note)
         VALUES (${audit}, 'admin', 'dispute', '{"${repetition}": 9}', 'not a loop')`,
      );
      await q(`INSERT INTO release_marker (agent_code, type, version, occurred_at) VALUES ('caller', 'scorecard', 'default@2', now())`);
      await q(
        `INSERT INTO daily_rollup (day, agent_code, scorecard_id, scorecard_version, audited, histogram)
         VALUES ('2026-10-23', 'caller', 'default', 2, 1, '{0,0,0,1,0}')`,
      );
      // A re-audit: a new row, and the old one points at it.
      const { id: newer } = await insertAudit(audit);
      await q(`UPDATE audit_results SET superseded_by = ${newer} WHERE id = ${audit}`);
      expect(await one(`SELECT cost::text AS cost, weights_used, superseded_by FROM audit_results WHERE id = ${audit}`)).toEqual({
        cost: "0.012300",
        weights_used: { flow_adherence: 10 },
        superseded_by: newer,
      });

      expect(await refused(`UPDATE audit_results SET trigger_mode = 'auto' WHERE id = ${audit}`)).toContain(
        "audit_results_trigger_mode_check",
      );
      expect(await refused(`UPDATE audit_results SET business_goal = 'MAYBE' WHERE id = ${audit}`)).toContain(
        "audit_results_business_goal_check",
      );
      expect(await refused(`UPDATE audit_results SET system_goal = 'MAYBE' WHERE id = ${audit}`)).toContain(
        "audit_results_system_goal_check",
      );
      expect(await refused(`UPDATE audit_results SET goal_version = 9 WHERE id = ${audit}`)).toContain("audit_results_goal_fkey");
      expect(await refused(`UPDATE audit_results SET scorecard_version = 9 WHERE id = ${audit}`)).toContain("audit_results_scorecard_fkey");
      expect(await refused(`INSERT INTO audit_check (audit_id, check_code, result) VALUES (${audit}, 'S5', 'PASS')`)).toContain(
        "audit_check_check_code_check",
      );
      expect(await refused(`INSERT INTO audit_check (audit_id, check_code, result) VALUES (${audit}, 'S1', 'FAIL')`)).toContain(
        "Validation error", // Sequelize's wording for a unique-key violation
      );
      expect(await refused(`UPDATE metric_result SET score = 5 WHERE metric_id = ${interruptions}`)).toContain("metric_result_score_check");
      expect(await refused(`UPDATE metric_result SET score = 11 WHERE metric_id = ${repetition}`)).toContain("metric_result_score_check");
      expect(
        await refused(
          `INSERT INTO failure_flag (audit_id, condition_code, severity, source) VALUES (${audit}, 'NOT_A_CODE', 'minor', 'judge')`,
        ),
      ).toContain("failure_flag_condition_code_fkey");
      expect(await refused(`INSERT INTO review (audit_id, reviewer, verdict) VALUES (${audit}, 'admin', 'maybe')`)).toContain(
        "review_verdict_check",
      );
      expect(
        await refused(
          `INSERT INTO daily_rollup (day, agent_code, scorecard_id, scorecard_version, histogram) VALUES ('2026-10-24', 'caller', 'default', 2, '{1,2}')`,
        ),
      ).toContain("daily_rollup_histogram_check");
      expect(await refused(`INSERT INTO audit_batch (created_by, trigger_mode, call_count) VALUES ('admin', 'single', 1)`)).toContain(
        "audit_batch_trigger_mode_check",
      );

      // Deleting the newer audit clears superseded_by; deleting a batch keeps its audits; an audit's details go with it.
      await q(`DELETE FROM audit_results WHERE id = ${newer}`);
      expect(await one(`SELECT superseded_by FROM audit_results WHERE id = ${audit}`)).toEqual({ superseded_by: null });
      await q(`DELETE FROM audit_batch WHERE id = ${batch}`);
      expect(await one(`SELECT batch_id FROM audit_results WHERE id = ${audit}`)).toEqual({ batch_id: null });
      await q(`DELETE FROM audit_results WHERE id = ${audit}`);
      const details =
        "SELECT 1 FROM audit_check UNION ALL SELECT 1 FROM metric_result UNION ALL SELECT 1 FROM failure_flag UNION ALL SELECT 1 FROM review";
      expect(await all(sequelize, details)).toEqual([]);
    }));

  it("loadActiveConfig resolves the agent from agent_code or agent_id, like agentFor", () =>
    withTestDb(async (sequelize) => {
      await createMigrator(sequelize, { quiet: true }).up();

      const hansa = await loadActiveConfig(sequelize, null, 1);
      expect([hansa.scorecard?.scorecard_id, hansa.scorecard?.version, hansa.goal?.agent_code, hansa.goal?.version]).toEqual([
        "hansa",
        3,
        "hrms",
        1,
      ]);
      expect(hansa.scorecard?.metrics).toHaveLength(10);
      expect(hansa.scorecard?.conditions.map((c) => c.condition_code)).toContain("DISCRIMINATORY_QUESTION");
      expect([hansa.scorecard?.pass_threshold, hansa.scorecard?.fail_score_cap]).toEqual([40, null]);
      expect(hansa.goal?.reason_codes.ACHIEVED).toEqual(["SCREENING_COMPLETED", "SLOT_CONFIRMED"]);
      expect(hansa.goal?.system_checks).toEqual({ silence_limit_s: 8, required_variables: [], flow_steps: null });

      const caller = await loadActiveConfig(sequelize, "CALLER", null);
      expect([caller.scorecard?.scorecard_id, caller.scorecard?.version, caller.scorecard?.metrics.length]).toEqual(["default", 3, 10]);
      const pm = await loadActiveConfig(sequelize, null, 4);
      expect([pm.scorecard?.scorecard_id, pm.scorecard?.version, pm.goal?.agent_code]).toEqual(["default", 3, "project-manager"]);

      expect(await loadActiveConfig(sequelize, null, 999)).toEqual({ scorecard: null, goal: null, reason: "unknown_agent" });
    }));
});

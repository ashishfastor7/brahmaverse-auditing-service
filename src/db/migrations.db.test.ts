import { describe, expect, it } from "bun:test";
import { QueryTypes, type Sequelize } from "sequelize";
import { migrations } from "./migrations";
import { createMigrator, migrateCommand, pendingMigrations } from "./migrator";
import { dbTestsEnabled, withTestDb } from "./test-db";

/** audit_results as `sequelize.sync()` created it before migrations (pg_dump of the dev database). */
const BASELINE_COLUMNS = [
  "id|integer||NO|nextval('audit_results_id_seq'::regclass)",
  "source|character varying|255|NO|",
  "call_id|integer||NO|",
  "business_id|integer||NO|",
  "agent_id|integer||YES|",
  "agent_code|character varying|255|YES|",
  "rubric_version|character varying|255|NO|",
  "status|character varying|255|NO|'pending'::character varying",
  "skip_reason|character varying|255|YES|",
  "error|text||YES|",
  "overall_score|integer||YES|",
  "quality_score|integer||YES|",
  "success_result|character varying|255|YES|",
  "goal_result|character varying|255|YES|",
  "goal_reason_code|character varying|255|YES|",
  "failure_codes|ARRAY||NO|(ARRAY[]::character varying[])::character varying(255)[]",
  "auditor_confidence|double precision||YES|",
  "needs_review|boolean||NO|false",
  "result|jsonb||YES|",
  "call|jsonb||NO|",
  "judge_model|character varying|255|YES|",
  "input_tokens|integer||YES|",
  "output_tokens|integer||YES|",
  "latency_ms|integer||YES|",
  "call_created_at|timestamp with time zone||YES|",
  "audited_at|timestamp with time zone||YES|",
  "created_at|timestamp with time zone||YES|",
  "updated_at|timestamp with time zone||YES|",
];

const BASELINE_INDEXES = [
  "CREATE INDEX audit_results_agent_code_call_created_at ON public.audit_results USING btree (agent_code, call_created_at)",
  "CREATE INDEX audit_results_business_id_call_created_at ON public.audit_results USING btree (business_id, call_created_at)",
  "CREATE UNIQUE INDEX audit_results_pkey ON public.audit_results USING btree (id)",
  "CREATE UNIQUE INDEX audit_results_source_call_id_rubric_version ON public.audit_results USING btree (source, call_id, rubric_version)",
  "CREATE INDEX audit_results_status ON public.audit_results USING btree (status)",
];

/** The DDL `sequelize.sync()` ran on databases created before migrations existed. */
const PRE_MIGRATION_DDL = `
  CREATE TABLE audit_results (id SERIAL, source VARCHAR(255) NOT NULL, call_id INTEGER NOT NULL, business_id INTEGER NOT NULL,
    agent_id INTEGER, agent_code VARCHAR(255), rubric_version VARCHAR(255) NOT NULL, status VARCHAR(255) NOT NULL DEFAULT 'pending',
    skip_reason VARCHAR(255), error TEXT, overall_score INTEGER, quality_score INTEGER, success_result VARCHAR(255),
    goal_result VARCHAR(255), goal_reason_code VARCHAR(255), failure_codes VARCHAR(255)[] NOT NULL DEFAULT ARRAY[]::VARCHAR(255)[],
    auditor_confidence FLOAT, needs_review BOOLEAN NOT NULL DEFAULT false, result JSONB, call JSONB NOT NULL, judge_model VARCHAR(255),
    input_tokens INTEGER, output_tokens INTEGER, latency_ms INTEGER, call_created_at TIMESTAMP WITH TIME ZONE,
    audited_at TIMESTAMP WITH TIME ZONE, created_at TIMESTAMP WITH TIME ZONE, updated_at TIMESTAMP WITH TIME ZONE, PRIMARY KEY (id));
  CREATE UNIQUE INDEX audit_results_source_call_id_rubric_version ON audit_results (source, call_id, rubric_version);
  CREATE INDEX audit_results_agent_code_call_created_at ON audit_results (agent_code, call_created_at);
  CREATE INDEX audit_results_business_id_call_created_at ON audit_results (business_id, call_created_at);
  CREATE INDEX audit_results_status ON audit_results (status);`;

async function schema(sequelize: Sequelize) {
  const columns = await sequelize.query<{ c: string }>(
    `SELECT column_name || '|' || data_type || '|' || coalesce(character_maximum_length::text, '') || '|' || is_nullable
       || '|' || coalesce(column_default, '') AS c
     FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'audit_results' ORDER BY ordinal_position`,
    { type: QueryTypes.SELECT },
  );
  const indexes = await sequelize.query<{ indexdef: string }>(
    "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'audit_results' ORDER BY indexname",
    { type: QueryTypes.SELECT },
  );
  return { columns: columns.map((r) => r.c), indexes: indexes.map((r) => r.indexdef) };
}

const tables = async (sequelize: Sequelize) =>
  (
    await sequelize.query<{ t: string }>("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1", {
      type: QueryTypes.SELECT,
    })
  ).map((r) => r.t);

const BASELINE = { columns: BASELINE_COLUMNS, indexes: BASELINE_INDEXES };
/** After 0002: the baseline plus the engine column. */
const WITH_ENGINE = {
  columns: [...BASELINE_COLUMNS, "engine|character varying|255|NO|'v1'::character varying"],
  indexes: BASELINE_INDEXES,
};
/** After every migration: plus the v2 audit fields (0006, 0009) and their indexes; the call key is v1-only (0012). */
const LATEST = {
  columns: [
    ...WITH_ENGINE.columns,
    "triggered_by|character varying|255|YES|",
    "trigger_mode|character varying|255|YES|",
    "batch_id|integer||YES|",
    "goal_version|integer||YES|",
    "scorecard_id|character varying|255|YES|",
    "scorecard_version|integer||YES|",
    "weights_used|jsonb||YES|",
    "system_goal|character varying|255|YES|",
    "business_goal|character varying|255|YES|",
    "business_reason|character varying|255|YES|",
    "judge_prompt_version|character varying|255|YES|",
    "cost|numeric||YES|",
    "superseded_by|integer||YES|",
    "score|numeric||YES|",
  ],
  indexes: [
    BASELINE_INDEXES[0],
    "CREATE INDEX audit_results_batch_id ON public.audit_results USING btree (batch_id)",
    BASELINE_INDEXES[1],
    BASELINE_INDEXES[2],
    "CREATE INDEX audit_results_scorecard ON public.audit_results USING btree (scorecard_id, scorecard_version)",
    BASELINE_INDEXES[4],
    "CREATE UNIQUE INDEX audit_results_v1_source_call_id_rubric_version ON public.audit_results USING btree (source, call_id, rubric_version) WHERE ((engine)::text = 'v1'::text)",
    "CREATE INDEX audit_results_v2_current ON public.audit_results USING btree (source, call_id) WHERE (((engine)::text = 'v2'::text) AND (superseded_by IS NULL))",
  ],
};
const ALL_TABLES = [
  "SequelizeMeta",
  "audit_batch",
  "audit_check",
  "audit_rescore",
  "audit_results",
  "daily_rollup",
  "failure_condition",
  "failure_flag",
  "goal_config",
  "metric",
  "metric_result",
  "release_marker",
  "review",
  "scorecard",
  "scorecard_assignment",
  "scorecard_condition",
];
const NAMES = migrations.map((m) => m.name);

describe.skipIf(!dbTestsEnabled)("migrations", () => {
  it("up -> down -> up on an empty database", () =>
    withTestDb(async (sequelize) => {
      const migrator = createMigrator(sequelize, { quiet: true });

      await migrator.up();
      expect(await schema(sequelize)).toEqual(LATEST);
      expect(await tables(sequelize)).toEqual(ALL_TABLES);

      await migrator.down({ to: "0003-config-tables" });
      expect(await schema(sequelize)).toEqual(WITH_ENGINE);
      expect(await tables(sequelize)).toEqual(["SequelizeMeta", "audit_results"]);

      await migrator.down(); // 0002
      expect(await schema(sequelize)).toEqual(BASELINE);

      await migrator.down({ to: 0 });
      expect((await schema(sequelize)).columns).toEqual([]);
      expect(await migrator.executed()).toEqual([]);

      await migrator.up();
      expect(await schema(sequelize)).toEqual(LATEST);
      expect(await tables(sequelize)).toEqual(ALL_TABLES);
      expect(await migrator.pending()).toEqual([]);
    }));

  it("every migration reverts on its own, newest first (as migrate:down does), then re-applies", () =>
    withTestDb(async (sequelize) => {
      const migrator = createMigrator(sequelize, { quiet: true });
      await migrator.up();
      for (const name of [...NAMES].reverse()) {
        await migrator.down();
        expect((await migrator.executed()).map((m) => m.name)).toEqual(NAMES.slice(0, NAMES.indexOf(name)));
      }
      expect(await tables(sequelize)).toEqual(["SequelizeMeta"]);
      await migrator.up();
      expect(await tables(sequelize)).toEqual(ALL_TABLES);
    }));

  it("on a database created by sequelize.sync(), keeps the rows and marks them engine 'v1'", () =>
    withTestDb(async (sequelize) => {
      await sequelize.query(PRE_MIGRATION_DDL);
      await sequelize.query(
        `INSERT INTO audit_results (source, call_id, business_id, rubric_version, call) VALUES ('voice_call_logs', 1, 2, 'hansa@1', '{}')`,
      );

      const migrator = createMigrator(sequelize, { quiet: true });
      await migrator.up({ to: "0001-baseline" });
      expect(await schema(sequelize)).toEqual(BASELINE);

      await migrator.up();
      expect(await schema(sequelize)).toEqual(LATEST);
      const rows = await sequelize.query<{ engine: string }>("SELECT engine FROM audit_results", { type: QueryTypes.SELECT });
      expect(rows).toEqual([{ engine: "v1" }]);
    }));

  it("engine accepts only 'v1' and 'v2'", () =>
    withTestDb(async (sequelize) => {
      await createMigrator(sequelize, { quiet: true }).up();
      const insert = (engine: string) =>
        sequelize.query(
          `INSERT INTO audit_results (engine, source, call_id, business_id, rubric_version, call) VALUES ('${engine}', 's', 1, 2, '${engine}', '{}')`,
        );
      await insert("v2");
      // (Bun 1.2's `expect(...).rejects` hangs on Sequelize errors, hence the catch.)
      const error = await insert("v3").then(
        () => null,
        (e: Error) => e.message,
      );
      expect(error).toContain("audit_results_engine_check");
    }));

  it("0012: v2 rows of one call pile up, v1 rows stay one per rubric version, and down refuses while v2 history exists", () =>
    withTestDb(async (sequelize) => {
      const migrator = createMigrator(sequelize, { quiet: true });
      await migrator.up();
      const insert = (engine: string) =>
        sequelize.query(
          `INSERT INTO audit_results (engine, source, call_id, business_id, rubric_version, call) VALUES ('${engine}', 's', 1, 2, 'r', '{}')`,
        );
      await insert("v2");
      await insert("v2");
      await insert("v1");
      // Sequelize reports a unique violation as "Validation error"; the index is on the pg error
      const violated = await insert("v1").then(
        () => null,
        (e: any) => e.original?.constraint ?? e.message,
      );
      expect(violated).toBe("audit_results_v1_source_call_id_rubric_version");

      const refused = await migrator.down().then(
        () => null,
        (e: Error) => e.message,
      );
      expect(refused).toContain("v2 re-audits keep several rows, e.g. call 1 r (3 rows)");
      await sequelize.query("DELETE FROM audit_results WHERE engine = 'v2'");
      await migrator.down();
      expect((await schema(sequelize)).indexes).toContain(BASELINE_INDEXES[3]);
    }));

  it("pendingMigrations (the startup check) lists what migrate would apply, without writing", () =>
    withTestDb(async (sequelize) => {
      expect(await pendingMigrations(sequelize)).toEqual(NAMES);
      const tables = await sequelize.query("SELECT 1 FROM information_schema.tables WHERE table_schema = 'public'", {
        type: QueryTypes.SELECT,
      });
      expect(tables).toEqual([]);

      const migrator = createMigrator(sequelize, { quiet: true });
      await migrator.up({ to: "0001-baseline" });
      expect(await pendingMigrations(sequelize)).toEqual(NAMES.slice(1));
      await migrator.up();
      expect(await pendingMigrations(sequelize)).toEqual([]);
    }));

  it("bun run migrate / migrate:down: applies, is a no-op when current, reverts one at a time, guards the baseline", () =>
    withTestDb(async (sequelize) => {
      expect(await migrateCommand(sequelize)).toBe(`applied ${NAMES.join(", ")}`);
      expect(await migrateCommand(sequelize)).toBe("up to date");

      for (const name of NAMES.slice(1).reverse()) expect(await migrateCommand(sequelize, { down: true })).toBe(`reverted ${name}`);
      expect(await schema(sequelize)).toEqual(BASELINE);

      const refused = await migrateCommand(sequelize, { down: true }).then(
        () => null,
        (e: Error) => e.message,
      );
      expect(refused).toContain("--drop-table");
      expect(await schema(sequelize)).toEqual(BASELINE);

      expect(await migrateCommand(sequelize, { down: true, dropTable: true })).toBe("reverted 0001-baseline");
      expect(await migrateCommand(sequelize, { down: true })).toBe("nothing to revert");
    }));
});

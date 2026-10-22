import { describe, expect, it } from "bun:test";
import { QueryTypes, type Sequelize } from "sequelize";
import { createMigrator } from "./migrator";
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

const BASELINE = { columns: BASELINE_COLUMNS, indexes: BASELINE_INDEXES };

describe.skipIf(!dbTestsEnabled)("migrations", () => {
  it("up -> down -> up on an empty database gives the baseline schema each time", () =>
    withTestDb(async (sequelize) => {
      const migrator = createMigrator(sequelize, { quiet: true });

      await migrator.up();
      expect(await schema(sequelize)).toEqual(BASELINE);

      await migrator.down({ to: 0 });
      expect((await schema(sequelize)).columns).toEqual([]);
      expect(await migrator.executed()).toEqual([]);

      await migrator.up();
      expect(await schema(sequelize)).toEqual(BASELINE);
      expect(await migrator.pending()).toEqual([]);
    }));

  it("on a database created by sequelize.sync(), records the baseline without touching the table or its rows", () =>
    withTestDb(async (sequelize) => {
      await sequelize.query(PRE_MIGRATION_DDL);
      await sequelize.query(
        `INSERT INTO audit_results (source, call_id, business_id, rubric_version, call) VALUES ('voice_call_logs', 1, 2, 'hansa@1', '{}')`,
      );

      const applied = await createMigrator(sequelize, { quiet: true }).up();
      expect(applied.map((m) => m.name)).toContain("0001-baseline");
      expect(await schema(sequelize)).toEqual(BASELINE);
      const [{ n }] = await sequelize.query<{ n: string }>("SELECT count(*) AS n FROM audit_results", { type: QueryTypes.SELECT });
      expect(Number(n)).toBe(1);
    }));
});

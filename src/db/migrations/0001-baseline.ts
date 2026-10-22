import type { Migration } from "@/db/migrator";

/**
 * audit_results exactly as `sequelize.sync()` created it before migrations existed (copied from pg_dump),
 * including the index names. `IF NOT EXISTS` makes this a no-op on a database that already has the table,
 * so it only gets recorded as applied there.
 */
export const up: Migration = async ({ context: sequelize }) => {
  await sequelize.transaction(async (transaction) => {
    await sequelize.query(
      `CREATE TABLE IF NOT EXISTS audit_results (
        id SERIAL PRIMARY KEY,
        source VARCHAR(255) NOT NULL,
        call_id INTEGER NOT NULL,
        business_id INTEGER NOT NULL,
        agent_id INTEGER,
        agent_code VARCHAR(255),
        rubric_version VARCHAR(255) NOT NULL,
        status VARCHAR(255) NOT NULL DEFAULT 'pending',
        skip_reason VARCHAR(255),
        error TEXT,
        overall_score INTEGER,
        quality_score INTEGER,
        success_result VARCHAR(255),
        goal_result VARCHAR(255),
        goal_reason_code VARCHAR(255),
        failure_codes VARCHAR(255)[] NOT NULL DEFAULT ARRAY[]::VARCHAR(255)[],
        auditor_confidence DOUBLE PRECISION,
        needs_review BOOLEAN NOT NULL DEFAULT false,
        result JSONB,
        call JSONB NOT NULL,
        judge_model VARCHAR(255),
        input_tokens INTEGER,
        output_tokens INTEGER,
        latency_ms INTEGER,
        call_created_at TIMESTAMP WITH TIME ZONE,
        audited_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE,
        updated_at TIMESTAMP WITH TIME ZONE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS audit_results_source_call_id_rubric_version ON audit_results (source, call_id, rubric_version);
      CREATE INDEX IF NOT EXISTS audit_results_agent_code_call_created_at ON audit_results (agent_code, call_created_at);
      CREATE INDEX IF NOT EXISTS audit_results_business_id_call_created_at ON audit_results (business_id, call_created_at);
      CREATE INDEX IF NOT EXISTS audit_results_status ON audit_results (status);`,
      { transaction },
    );
  });
};

export const down: Migration = async ({ context: sequelize }) => {
  await sequelize.query("DROP TABLE audit_results");
};

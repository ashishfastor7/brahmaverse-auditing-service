import type { Migration } from "@/db/migrator";

/**
 * Per-audit detail rows for v2 (PRD §5, §7): system checks S1–S4, raw metric scores (so a call can be re-scored with
 * new weights without the LLM), flagged failure conditions, and human reviews. All go with their audit.
 */
export const up: Migration = async ({ context: sequelize }) => {
  await sequelize.transaction(async (transaction) => {
    await sequelize.query(
      `CREATE TABLE audit_check (
        id SERIAL PRIMARY KEY,
        audit_id INTEGER NOT NULL REFERENCES audit_results (id) ON DELETE CASCADE,
        check_code VARCHAR(255) NOT NULL CONSTRAINT audit_check_check_code_check CHECK (check_code IN ('S1', 'S2', 'S3', 'S4')),
        result VARCHAR(255) NOT NULL CONSTRAINT audit_check_result_check CHECK (result IN ('PASS', 'FAIL', 'NOT_APPLICABLE')),
        reason TEXT,
        evidence JSONB NOT NULL DEFAULT '[]',
        UNIQUE (audit_id, check_code)
      );

      CREATE TABLE metric_result (
        id SERIAL PRIMARY KEY,
        audit_id INTEGER NOT NULL REFERENCES audit_results (id) ON DELETE CASCADE,
        metric_id INTEGER NOT NULL REFERENCES metric (id),
        score NUMERIC(6,2),
        max NUMERIC(6,2) NOT NULL,
        n_a BOOLEAN NOT NULL DEFAULT false,
        reason TEXT,
        evidence JSONB NOT NULL DEFAULT '[]',
        UNIQUE (audit_id, metric_id),
        CONSTRAINT metric_result_score_check CHECK ((n_a AND score IS NULL) OR (NOT n_a AND score BETWEEN 0 AND max))
      );

      CREATE TABLE failure_flag (
        id SERIAL PRIMARY KEY,
        audit_id INTEGER NOT NULL REFERENCES audit_results (id) ON DELETE CASCADE,
        condition_code VARCHAR(255) NOT NULL REFERENCES failure_condition (code),
        severity VARCHAR(255) NOT NULL CONSTRAINT failure_flag_severity_check CHECK (severity IN ('critical', 'major', 'minor')),
        source VARCHAR(255) NOT NULL CONSTRAINT failure_flag_source_check CHECK (source IN ('rule', 'judge')),
        reason TEXT,
        evidence JSONB NOT NULL DEFAULT '[]'
      );
      CREATE INDEX failure_flag_audit_id ON failure_flag (audit_id);
      CREATE INDEX failure_flag_condition_code ON failure_flag (condition_code);

      CREATE TABLE review (
        id SERIAL PRIMARY KEY,
        audit_id INTEGER NOT NULL REFERENCES audit_results (id) ON DELETE CASCADE,
        reviewer VARCHAR(255) NOT NULL,
        verdict VARCHAR(255) NOT NULL CONSTRAINT review_verdict_check CHECK (verdict IN ('agree', 'dispute', 'flag')),
        corrected_scores JSONB,
        note TEXT,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
      );
      CREATE INDEX review_audit_id ON review (audit_id);`,
      { transaction },
    );
  });
};

export const down: Migration = async ({ context: sequelize }) => {
  await sequelize.query("DROP TABLE review, failure_flag, metric_result, audit_check");
};

import type { Migration } from "@/db/migrator";

/**
 * Re-scores (PRD §4.4, §5 item 8; decided 2026-10-23). A re-score applies new weights to an audit's stored metric
 * results without the judge. It is history of that audit, not a new audit: each one is a row in `audit_rescore`, and
 * the audit row keeps the score it was audited with, which is what the dashboard counts.
 *
 * Also the v2 score itself: one decimal (`overall_score` is an integer and stays v1's). Null on v1 rows.
 */
export const up: Migration = async ({ context: sequelize }) => {
  await sequelize.transaction(async (transaction) => {
    await sequelize.query(
      `ALTER TABLE audit_results
        ADD COLUMN score NUMERIC(4,1) CONSTRAINT audit_results_score_check CHECK (score BETWEEN 0 AND 100);

      CREATE TABLE audit_rescore (
        id SERIAL PRIMARY KEY,
        audit_id INTEGER NOT NULL REFERENCES audit_results (id) ON DELETE CASCADE,
        weights_used JSONB NOT NULL,
        score NUMERIC(4,1) CONSTRAINT audit_rescore_score_check CHECK (score BETWEEN 0 AND 100),
        passed BOOLEAN NOT NULL,
        failed_by JSONB NOT NULL DEFAULT '[]',
        created_by VARCHAR(255) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
      );
      CREATE INDEX audit_rescore_audit_id_created_at ON audit_rescore (audit_id, created_at);`,
      { transaction },
    );
  });
};

export const down: Migration = async ({ context: sequelize }) => {
  await sequelize.query("DROP TABLE audit_rescore; ALTER TABLE audit_results DROP COLUMN score;");
};

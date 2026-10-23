import type { Migration } from "@/db/migrator";

/**
 * The v2 audit fields (PRD §7) on audit_results, all nullable so v1 rows are untouched. v1 rows are linked to the
 * 5 × 20 template they were graded on (`hansa` v1 or `default` v1, by rubric_version); nothing else on them changes,
 * `updated_at` included. Their goal_version stays null: their goals came from the code rubric.
 */
export const up: Migration = async ({ context: sequelize }) => {
  await sequelize.transaction(async (transaction) => {
    await sequelize.query(
      `ALTER TABLE audit_results
        ADD COLUMN triggered_by VARCHAR(255),
        ADD COLUMN trigger_mode VARCHAR(255)
          CONSTRAINT audit_results_trigger_mode_check CHECK (trigger_mode IN ('single', 'selected', 'filter', 'sample')),
        ADD COLUMN batch_id INTEGER CONSTRAINT audit_results_batch_id_fkey REFERENCES audit_batch (id) ON DELETE SET NULL,
        ADD COLUMN goal_version INTEGER,
        ADD COLUMN scorecard_id VARCHAR(255),
        ADD COLUMN scorecard_version INTEGER,
        ADD COLUMN weights_used JSONB,
        ADD COLUMN system_goal VARCHAR(255)
          CONSTRAINT audit_results_system_goal_check CHECK (system_goal IN ('PASS', 'FAIL', 'NOT_APPLICABLE')),
        ADD COLUMN business_goal VARCHAR(255)
          CONSTRAINT audit_results_business_goal_check CHECK (business_goal IN ('ACHIEVED', 'PARTIAL', 'NOT_ACHIEVED', 'NOT_APPLICABLE')),
        ADD COLUMN business_reason VARCHAR(255),
        ADD COLUMN judge_prompt_version VARCHAR(255),
        ADD COLUMN cost NUMERIC(12,6),
        ADD COLUMN superseded_by INTEGER CONSTRAINT audit_results_superseded_by_fkey REFERENCES audit_results (id) ON DELETE SET NULL,
        ADD CONSTRAINT audit_results_goal_fkey FOREIGN KEY (agent_code, goal_version) REFERENCES goal_config (agent_code, version),
        ADD CONSTRAINT audit_results_scorecard_fkey FOREIGN KEY (scorecard_id, scorecard_version) REFERENCES scorecard (scorecard_id, version);
      CREATE INDEX audit_results_batch_id ON audit_results (batch_id);
      CREATE INDEX audit_results_scorecard ON audit_results (scorecard_id, scorecard_version);

      UPDATE audit_results
         SET scorecard_id = CASE WHEN rubric_version LIKE 'hansa-%' THEN 'hansa' ELSE 'default' END, scorecard_version = 1
       WHERE engine = 'v1' AND (rubric_version LIKE 'hansa-%' OR rubric_version LIKE 'default-%');`,
      { transaction },
    );
  });
};

export const down: Migration = async ({ context: sequelize }) => {
  await sequelize.query(
    `DROP INDEX audit_results_batch_id, audit_results_scorecard;
     ALTER TABLE audit_results
       DROP COLUMN triggered_by, DROP COLUMN trigger_mode, DROP COLUMN batch_id, DROP COLUMN goal_version,
       DROP COLUMN scorecard_id, DROP COLUMN scorecard_version, DROP COLUMN weights_used, DROP COLUMN system_goal,
       DROP COLUMN business_goal, DROP COLUMN business_reason, DROP COLUMN judge_prompt_version, DROP COLUMN cost,
       DROP COLUMN superseded_by;`,
  );
};

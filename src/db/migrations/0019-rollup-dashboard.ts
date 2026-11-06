import type { Migration } from "@/db/migrator";

/**
 * P2-7 – P2-9 dashboard (PRD §6): what the roll-ups need for its filters and panels.
 * - Both tables gain `direction` (inbound / outbound / unknown) in their key, and `daily_rollup` gains `goal_version`,
 *   so the direction and business-goal filters read roll-ups only.
 * - `sampled`: audits from a random sample; the rest were hand-picked (the PRD §6 warning).
 * - `system_checks` (S1–S4 → pass/fail/na), `business_reasons` (NOT_ACHIEVED reason → calls) for the funnel and the
 *   top failure causes. `metric_averages[key].lost` (calls under full marks) is JSONB, so it needs no column.
 * - `rs_*`: pass/fail, score and histogram of the same audits re-scored with their agent's assigned scorecard (one
 *   weight set), for the "as audited / re-scored" toggle (PRD §6, P2-10). Goals and buckets don't depend on weights.
 * Roll-ups are derived data: both tables are emptied here, and `bun run rollup:rebuild` (or the nightly job) refills them.
 */
export const up: Migration = async ({ context: sequelize }) => {
  await sequelize.transaction(async (transaction) => {
    await sequelize.query(
      `TRUNCATE daily_rollup, daily_call_rollup;

       ALTER TABLE daily_rollup
         DROP CONSTRAINT daily_rollup_pkey,
         ADD COLUMN direction VARCHAR(16) NOT NULL DEFAULT 'unknown'
           CONSTRAINT daily_rollup_direction_check CHECK (direction IN ('inbound', 'outbound', 'unknown')),
         ADD COLUMN goal_version INTEGER NOT NULL DEFAULT 0,
         ADD COLUMN sampled INTEGER NOT NULL DEFAULT 0,
         ADD COLUMN system_checks JSONB NOT NULL DEFAULT '{}',
         ADD COLUMN business_reasons JSONB NOT NULL DEFAULT '{}',
         ADD COLUMN rs_passed INTEGER NOT NULL DEFAULT 0,
         ADD COLUMN rs_failed INTEGER NOT NULL DEFAULT 0,
         ADD COLUMN rs_score_sum NUMERIC(12,2) NOT NULL DEFAULT 0,
         ADD COLUMN rs_scored INTEGER NOT NULL DEFAULT 0,
         ADD COLUMN rs_histogram INTEGER[] NOT NULL DEFAULT '{0,0,0,0,0}'
           CONSTRAINT daily_rollup_rs_histogram_check CHECK (cardinality(rs_histogram) = 5),
         ADD PRIMARY KEY (day, agent_code, direction, scorecard_id, scorecard_version, goal_version);

       ALTER TABLE daily_call_rollup
         DROP CONSTRAINT daily_call_rollup_pkey,
         ADD COLUMN direction VARCHAR(16) NOT NULL DEFAULT 'unknown'
           CONSTRAINT daily_call_rollup_direction_check CHECK (direction IN ('inbound', 'outbound', 'unknown')),
         ADD PRIMARY KEY (day, agent_code, direction);`,
      { transaction },
    );
  });
};

export const down: Migration = async ({ context: sequelize }) => {
  await sequelize.transaction(async (transaction) => {
    await sequelize.query(
      `TRUNCATE daily_rollup, daily_call_rollup;

       ALTER TABLE daily_call_rollup
         DROP CONSTRAINT daily_call_rollup_pkey,
         DROP COLUMN direction,
         ADD PRIMARY KEY (day, agent_code);

       ALTER TABLE daily_rollup
         DROP CONSTRAINT daily_rollup_pkey,
         DROP COLUMN direction, DROP COLUMN goal_version, DROP COLUMN sampled, DROP COLUMN system_checks,
         DROP COLUMN business_reasons, DROP COLUMN rs_passed, DROP COLUMN rs_failed, DROP COLUMN rs_score_sum,
         DROP COLUMN rs_scored, DROP COLUMN rs_histogram,
         ADD PRIMARY KEY (day, agent_code, scorecard_id, scorecard_version);`,
      { transaction },
    );
  });
};

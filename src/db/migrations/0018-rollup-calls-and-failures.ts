import type { Migration } from "@/db/migrator";

/**
 * P2-6 roll-ups (PRD §6, §7). `daily_rollup` (0008) gains failure-code counts (code → calls) and `scored`, the number
 * of audits behind `score_sum`. Call counts come from the source `voice_call_logs` on another database and have no
 * scorecard, so they get their own table per IST day and agent: connected = completed, not connected = no_answer +
 * failed, every other status only in `total`.
 */
export const up: Migration = async ({ context: sequelize }) => {
  await sequelize.transaction(async (transaction) => {
    await sequelize.query(
      `ALTER TABLE daily_rollup
         ADD COLUMN failure_codes JSONB NOT NULL DEFAULT '{}',
         ADD COLUMN scored INTEGER NOT NULL DEFAULT 0;

       CREATE TABLE daily_call_rollup (
         day DATE NOT NULL,
         agent_code VARCHAR(255) NOT NULL,
         total INTEGER NOT NULL DEFAULT 0,
         connected INTEGER NOT NULL DEFAULT 0,
         not_connected INTEGER NOT NULL DEFAULT 0,
         refreshed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         PRIMARY KEY (day, agent_code),
         CONSTRAINT daily_call_rollup_counts_check CHECK (connected >= 0 AND not_connected >= 0 AND connected + not_connected <= total)
       );`,
      { transaction },
    );
  });
};

export const down: Migration = async ({ context: sequelize }) => {
  await sequelize.query(
    `DROP TABLE daily_call_rollup;
     ALTER TABLE daily_rollup DROP COLUMN failure_codes, DROP COLUMN scored;`,
  );
};

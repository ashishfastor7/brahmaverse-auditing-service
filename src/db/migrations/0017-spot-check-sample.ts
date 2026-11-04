import type { Migration } from "@/db/migrator";

/**
 * Blind spot-checks (P2-18, PRD §8 #2, §9): each row is one draw of a week's sample. `candidate_ids` are the audits it
 * drew from and `seed` the random seed, so `pickSpotChecks(candidates, seed, per_agent)` gives `audit_ids` again. A
 * week can have several draws: a later one tops up agents that were short, from audits made since.
 */
export const up: Migration = async ({ context: sequelize }) => {
  await sequelize.query(
    `CREATE TABLE spot_check_sample (
      id SERIAL PRIMARY KEY,
      week_start DATE NOT NULL,
      seed BIGINT NOT NULL,
      per_agent INTEGER NOT NULL CONSTRAINT spot_check_sample_per_agent_check CHECK (per_agent > 0),
      candidate_ids INTEGER[] NOT NULL,
      audit_ids INTEGER[] NOT NULL,
      created_by VARCHAR(255) NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
    );
    CREATE INDEX spot_check_sample_week_start ON spot_check_sample (week_start);`,
  );
};

export const down: Migration = async ({ context: sequelize }) => {
  await sequelize.query("DROP TABLE spot_check_sample");
};

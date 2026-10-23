import type { Migration } from "@/db/migrator";

/**
 * Dashboard support (PRD §6, §7): release markers drawn on trends, and one rollup row per IST day, agent and
 * scorecard version (trends never mix scorecard versions). Filling the rollup is P2-6.
 */
export const up: Migration = async ({ context: sequelize }) => {
  await sequelize.transaction(async (transaction) => {
    await sequelize.query(
      `CREATE TABLE release_marker (
        id SERIAL PRIMARY KEY,
        agent_code VARCHAR(255) NOT NULL,
        type VARCHAR(255) NOT NULL CONSTRAINT release_marker_type_check CHECK (type IN ('prompt', 'flow', 'voice', 'scorecard')),
        version VARCHAR(255),
        occurred_at TIMESTAMP WITH TIME ZONE NOT NULL,
        note TEXT,
        created_by VARCHAR(255),
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
      );
      CREATE INDEX release_marker_agent_code_occurred_at ON release_marker (agent_code, occurred_at);

      CREATE TABLE daily_rollup (
        day DATE NOT NULL,
        agent_code VARCHAR(255) NOT NULL,
        scorecard_id VARCHAR(255) NOT NULL,
        scorecard_version INTEGER NOT NULL,
        audited INTEGER NOT NULL DEFAULT 0,
        passed INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        needs_review INTEGER NOT NULL DEFAULT 0,
        system_pass INTEGER NOT NULL DEFAULT 0,
        system_fail INTEGER NOT NULL DEFAULT 0,
        system_na INTEGER NOT NULL DEFAULT 0,
        business_achieved INTEGER NOT NULL DEFAULT 0,
        business_partial INTEGER NOT NULL DEFAULT 0,
        business_not_achieved INTEGER NOT NULL DEFAULT 0,
        business_na INTEGER NOT NULL DEFAULT 0,
        score_sum NUMERIC(12,2) NOT NULL DEFAULT 0,
        buckets JSONB NOT NULL DEFAULT '{}',
        histogram INTEGER[] NOT NULL DEFAULT '{0,0,0,0,0}' CONSTRAINT daily_rollup_histogram_check CHECK (cardinality(histogram) = 5),
        metric_averages JSONB NOT NULL DEFAULT '{}',
        refreshed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        PRIMARY KEY (day, agent_code, scorecard_id, scorecard_version),
        FOREIGN KEY (scorecard_id, scorecard_version) REFERENCES scorecard (scorecard_id, version)
      );`,
      { transaction },
    );
  });
};

export const down: Migration = async ({ context: sequelize }) => {
  await sequelize.query("DROP TABLE daily_rollup, release_marker");
};

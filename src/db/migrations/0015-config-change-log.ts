import type { Migration } from "@/db/migrator";

/**
 * The config change log (PRD §8 #14, P1-18): one row per draft started, draft saved, version published or draft
 * discarded, for scorecards and goal configs. `changes` lists what moved (`[{ field, before, after }]`, from
 * `config-diff.ts`). With one shared login, `changed_by` is that login, not a person.
 */
export const up: Migration = async ({ context: sequelize }) => {
  await sequelize.query(
    `CREATE TABLE config_change (
      id SERIAL PRIMARY KEY,
      entity VARCHAR(255) NOT NULL CONSTRAINT config_change_entity_check CHECK (entity IN ('scorecard', 'goal_config')),
      config_key VARCHAR(255) NOT NULL,
      version INTEGER NOT NULL,
      action VARCHAR(255) NOT NULL CONSTRAINT config_change_action_check
        CHECK (action IN ('draft_created', 'edited', 'published', 'discarded')),
      changes JSONB NOT NULL DEFAULT '[]',
      changed_by VARCHAR(255) NOT NULL,
      changed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
    );
    CREATE INDEX config_change_entity_key_version ON config_change (entity, config_key, version);`,
  );
};

export const down: Migration = async ({ context: sequelize }) => {
  await sequelize.query("DROP TABLE config_change");
};

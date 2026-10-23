import type { Migration } from "@/db/migrator";

/**
 * A bulk audit a user started (PRD §7): *Audit selected* or *Audit all matching*, optionally a random sample.
 * `filters` holds what the user picked (the call-list filters, or `{call_ids}` for a selection). The runner is P1-13.
 */
export const up: Migration = async ({ context: sequelize }) => {
  await sequelize.query(
    `CREATE TABLE audit_batch (
      id SERIAL PRIMARY KEY,
      created_by VARCHAR(255) NOT NULL,
      trigger_mode VARCHAR(255) NOT NULL CONSTRAINT audit_batch_trigger_mode_check CHECK (trigger_mode IN ('selected', 'filter', 'sample')),
      filters JSONB NOT NULL DEFAULT '{}',
      call_count INTEGER NOT NULL CONSTRAINT audit_batch_call_count_check CHECK (call_count >= 0),
      status VARCHAR(255) NOT NULL DEFAULT 'queued'
        CONSTRAINT audit_batch_status_check CHECK (status IN ('queued', 'running', 'completed', 'cancelled', 'failed')),
      completed_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      started_at TIMESTAMP WITH TIME ZONE,
      finished_at TIMESTAMP WITH TIME ZONE
    )`,
  );
};

export const down: Migration = async ({ context: sequelize }) => {
  await sequelize.query("DROP TABLE audit_batch");
};

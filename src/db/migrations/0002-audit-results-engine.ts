import type { Migration } from "@/db/migrator";

/** Which audit engine wrote the row. The default backfills every existing row as 'v1'. */
export const up: Migration = async ({ context: sequelize }) => {
  await sequelize.query(
    `ALTER TABLE audit_results
       ADD COLUMN engine VARCHAR(255) NOT NULL DEFAULT 'v1'
       CONSTRAINT audit_results_engine_check CHECK (engine IN ('v1', 'v2'))`,
  );
};

export const down: Migration = async ({ context: sequelize }) => {
  await sequelize.query("ALTER TABLE audit_results DROP COLUMN engine");
};

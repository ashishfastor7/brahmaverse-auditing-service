import type { Migration } from "@/db/migrator";
import { QueryTypes } from "sequelize";

/**
 * v2 audit history (PRD §7: a re-audit creates a new row and marks the old one superseded). The one-row-per-(call,
 * rubric version) key now holds for v1 rows only, where re-audits still overwrite in place; v2 rows of the same call
 * pile up, and the current one is the row with no `superseded_by` (indexed for the call page).
 */
export const up: Migration = async ({ context: sequelize }) => {
  await sequelize.transaction(async (transaction) => {
    await sequelize.query(
      `DROP INDEX audit_results_source_call_id_rubric_version;
       CREATE UNIQUE INDEX audit_results_v1_source_call_id_rubric_version ON audit_results (source, call_id, rubric_version)
         WHERE engine = 'v1';
       CREATE INDEX audit_results_v2_current ON audit_results (source, call_id) WHERE engine = 'v2' AND superseded_by IS NULL;`,
      { transaction },
    );
  });
};

/** Restores the key on every row; refuses when v2 history would break it (delete those rows first). */
export const down: Migration = async ({ context: sequelize }) => {
  const clashes = await sequelize.query<{ call_id: number; rubric_version: string; n: number }>(
    `SELECT call_id, rubric_version, count(*)::int AS n FROM audit_results GROUP BY source, call_id, rubric_version HAVING count(*) > 1`,
    { type: QueryTypes.SELECT },
  );
  if (clashes.length) {
    const list = clashes
      .slice(0, 10)
      .map((c) => `call ${c.call_id} ${c.rubric_version} (${c.n} rows)`)
      .join(", ");
    throw new Error(`can't restore the one-row-per-(call, rubric version) key: v2 re-audits keep several rows, e.g. ${list}`);
  }
  await sequelize.transaction(async (transaction) => {
    await sequelize.query(
      `DROP INDEX audit_results_v2_current, audit_results_v1_source_call_id_rubric_version;
       CREATE UNIQUE INDEX audit_results_source_call_id_rubric_version ON audit_results (source, call_id, rubric_version);`,
      { transaction },
    );
  });
};

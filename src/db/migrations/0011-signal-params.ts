import type { Migration } from "@/db/migrator";
import { SIGNAL_PARAMS, V4_SCORECARDS } from "./0011-signal-params.data";

/**
 * Params for the transcript signals (step 9): publishes `default` v4 and `hansa` v4, which are v3 with the Repetition,
 * Stalling & filler and Language match params set (published versions can't change), then moves the agents on v3 to v4.
 */
export const up: Migration = async ({ context: sequelize }) => {
  await sequelize.transaction(async (transaction) => {
    const q = (sql: string, bind: unknown[]) => sequelize.query(sql, { bind, transaction });

    for (const s of V4_SCORECARDS) {
      const key = [s.scorecard_id, s.from, s.version];
      await q(
        `INSERT INTO scorecard (scorecard_id, version, name, based_on, pass_threshold, fail_score_cap, created_by)
         SELECT scorecard_id, $3::int, $4::text, version, pass_threshold, fail_score_cap, 'migration' FROM scorecard WHERE scorecard_id = $1 AND version = $2`,
        [...key, s.name],
      );
      await q(
        `INSERT INTO metric (scorecard_id, scorecard_version, key, position, name, description, rubric, applicability, method, weight,
           scale, auto_fail, evidence_required, requires, params)
         SELECT scorecard_id, $3::int, key, position, name, description, rubric, applicability, method, weight,
           scale, auto_fail, evidence_required, requires, params FROM metric WHERE scorecard_id = $1 AND scorecard_version = $2`,
        key,
      );
      await q(
        `INSERT INTO scorecard_condition (scorecard_id, scorecard_version, condition_code, enabled, severity, metric_key)
         SELECT scorecard_id, $3::int, condition_code, enabled, severity, metric_key FROM scorecard_condition
          WHERE scorecard_id = $1 AND scorecard_version = $2`,
        key,
      );
      for (const [metric, params] of Object.entries(SIGNAL_PARAMS)) {
        await q(`UPDATE metric SET params = $4::jsonb WHERE scorecard_id = $1 AND scorecard_version = $2 AND key = $3`, [
          s.scorecard_id,
          s.version,
          metric,
          JSON.stringify(params),
        ]);
      }
      await q(`UPDATE scorecard SET status = 'published', published_at = now() WHERE scorecard_id = $1 AND version = $2`, [
        s.scorecard_id,
        s.version,
      ]);
      await q(
        `UPDATE scorecard_assignment SET scorecard_version = $3, assigned_by = 'migration', assigned_at = now()
          WHERE scorecard_id = $1 AND scorecard_version = $2`,
        key,
      );
    }
  });
};

/** Moves the agents back to v3 and removes v4 (triggers off for this alone, as in 0004 and 0010). */
export const down: Migration = async ({ context: sequelize }) => {
  const tables = ["scorecard", "metric", "scorecard_condition"];
  await sequelize.transaction(async (transaction) => {
    const q = (sql: string, bind: unknown[] = []) => sequelize.query(sql, { bind, transaction });
    for (const t of tables) await q(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
    for (const s of V4_SCORECARDS) {
      await q(
        `UPDATE scorecard_assignment SET scorecard_version = $2, assigned_by = 'migration', assigned_at = now()
          WHERE scorecard_id = $1 AND scorecard_version = $3`,
        [s.scorecard_id, s.from, s.version],
      );
      await q(`DELETE FROM scorecard WHERE scorecard_id = $1 AND version = $2`, [s.scorecard_id, s.version]);
    }
    for (const t of tables) await q(`ALTER TABLE ${t} ENABLE TRIGGER USER`);
  });
};

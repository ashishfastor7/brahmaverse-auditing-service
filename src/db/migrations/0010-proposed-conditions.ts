import type { Migration } from "@/db/migrator";
import { PROPOSED_CONDITIONS, V3_SCORECARDS } from "./0010-proposed-conditions.data";

/**
 * PRD §4.5 proposed failure conditions: adds them to the library as Minor and publishes `default` v3 and `hansa` v3
 * (v2 plus the new conditions; published versions can't change), then moves the agents on v2 to v3. The loop code is
 * already `AGENT_LOOP` and no stored audit has `"S"` (checked 2026-10-28), so there is nothing to rename.
 */
export const up: Migration = async ({ context: sequelize }) => {
  await sequelize.transaction(async (transaction) => {
    const q = (sql: string, bind: unknown[]) => sequelize.query(sql, { bind, transaction });

    for (const c of PROPOSED_CONDITIONS) {
      await q(
        `INSERT INTO failure_condition (code, label, definition, default_severity, rolls_up_to, detection) VALUES ($1, $2, $3, $4, $5, $6)`,
        [c.code, c.label, c.definition, c.default_severity, c.rolls_up_to, c.detection],
      );
    }

    for (const s of V3_SCORECARDS) {
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
      for (const c of s.conditions) {
        await q(
          `INSERT INTO scorecard_condition (scorecard_id, scorecard_version, condition_code, enabled, severity, metric_key)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [s.scorecard_id, s.version, c.condition_code, c.enabled, c.severity, c.metric_key],
        );
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

/** Moves the agents back to v2 and removes v3 and the new library rows (triggers off for this alone, as in 0004). */
export const down: Migration = async ({ context: sequelize }) => {
  const tables = ["scorecard", "metric", "scorecard_condition", "failure_condition"];
  await sequelize.transaction(async (transaction) => {
    const q = (sql: string, bind: unknown[] = []) => sequelize.query(sql, { bind, transaction });
    for (const t of tables) await q(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
    for (const s of V3_SCORECARDS) {
      await q(
        `UPDATE scorecard_assignment SET scorecard_version = $2, assigned_by = 'migration', assigned_at = now()
          WHERE scorecard_id = $1 AND scorecard_version = $3`,
        [s.scorecard_id, s.from, s.version],
      );
      await q(`DELETE FROM scorecard WHERE scorecard_id = $1 AND version = $2`, [s.scorecard_id, s.version]);
    }
    await q(`DELETE FROM failure_condition WHERE code = ANY($1)`, [PROPOSED_CONDITIONS.map((c) => c.code)]);
    for (const t of tables) await q(`ALTER TABLE ${t} ENABLE TRIGGER USER`);
  });
};

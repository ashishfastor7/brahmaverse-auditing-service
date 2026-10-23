import type { Migration } from "@/db/migrator";
import { ASSIGNMENTS, FAILURE_CONDITIONS, GOAL_CONFIGS, SCORECARDS } from "./0004-config-seed.data";

/**
 * Seeds the failure-condition library, goal config v1 for each agent, the v1 5 × 20 templates (`hansa` v1 and
 * `default` v1, which v1 audits link to in 0006) and the Caller's `default` v2 with the PRD §4.3 metrics, and points
 * each agent at its scorecard. Each version is inserted as a draft and then published, as the code does.
 */
export const up: Migration = async ({ context: sequelize }) => {
  await sequelize.transaction(async (transaction) => {
    const q = (sql: string, bind: unknown[]) => sequelize.query(sql, { bind, transaction });

    for (const c of FAILURE_CONDITIONS) {
      await q(
        `INSERT INTO failure_condition (code, label, definition, default_severity, rolls_up_to, detection) VALUES ($1, $2, $3, $4, $5, $6)`,
        [c.code, c.label, c.definition, c.default_severity, c.rolls_up_to, c.detection],
      );
    }

    for (const g of GOAL_CONFIGS) {
      await q(
        `INSERT INTO goal_config (agent_code, version, name, description, success_criteria, not_applicable_when, reason_codes, system_checks, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, 'migration')`,
        [
          g.agent_code,
          g.version,
          g.name,
          g.description,
          g.success_criteria,
          g.not_applicable_when,
          JSON.stringify(g.reason_codes),
          JSON.stringify(g.system_checks),
        ],
      );
      await q(`UPDATE goal_config SET status = 'published', published_at = now() WHERE agent_code = $1 AND version = $2`, [
        g.agent_code,
        g.version,
      ]);
    }

    for (const s of SCORECARDS) {
      await q(
        `INSERT INTO scorecard (scorecard_id, version, name, based_on, pass_threshold, fail_score_cap, created_by) VALUES ($1, $2, $3, $4, $5, $6, 'migration')`,
        [s.scorecard_id, s.version, s.name, s.based_on, s.pass_threshold, s.fail_score_cap],
      );
      for (const [position, m] of s.metrics.entries()) {
        await q(
          `INSERT INTO metric (scorecard_id, scorecard_version, key, position, name, description, rubric, applicability, method, weight, requires, params)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12::jsonb)`,
          [
            s.scorecard_id,
            s.version,
            m.key,
            position + 1,
            m.name,
            m.description,
            JSON.stringify({ checks: m.checks, anchors: m.anchors }),
            m.applicability,
            m.method,
            m.weight,
            m.requires,
            JSON.stringify(m.params),
          ],
        );
      }
      for (const c of s.conditions) {
        await q(
          `INSERT INTO scorecard_condition (scorecard_id, scorecard_version, condition_code, severity, metric_key) VALUES ($1, $2, $3, $4, $5)`,
          [s.scorecard_id, s.version, c.condition_code, c.severity, c.metric_key],
        );
      }
      await q(`UPDATE scorecard SET status = 'published', published_at = now() WHERE scorecard_id = $1 AND version = $2`, [
        s.scorecard_id,
        s.version,
      ]);
    }

    for (const a of ASSIGNMENTS) {
      await q(
        `INSERT INTO scorecard_assignment (agent_code, scorecard_id, scorecard_version, assigned_by) VALUES ($1, $2, $3, 'migration')`,
        [a.agent_code, a.scorecard_id, a.scorecard_version],
      );
    }
  });
};

/** Removes exactly the seeded rows. They are published, so the immutability triggers are switched off for this alone. */
export const down: Migration = async ({ context: sequelize }) => {
  const tables = ["scorecard", "metric", "scorecard_condition", "goal_config", "failure_condition"];
  await sequelize.transaction(async (transaction) => {
    const q = (sql: string, bind: unknown[] = []) => sequelize.query(sql, { bind, transaction });
    for (const t of tables) await q(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
    await q(`DELETE FROM scorecard_assignment WHERE agent_code = ANY($1)`, [ASSIGNMENTS.map((a) => a.agent_code)]);
    for (const s of SCORECARDS) await q(`DELETE FROM scorecard WHERE scorecard_id = $1 AND version = $2`, [s.scorecard_id, s.version]);
    for (const g of GOAL_CONFIGS) await q(`DELETE FROM goal_config WHERE agent_code = $1 AND version = $2`, [g.agent_code, g.version]);
    await q(`DELETE FROM failure_condition WHERE code = ANY($1)`, [FAILURE_CONDITIONS.map((c) => c.code)]);
    for (const t of tables) await q(`ALTER TABLE ${t} ENABLE TRIGGER USER`);
  });
};

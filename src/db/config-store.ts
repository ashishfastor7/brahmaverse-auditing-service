import { agentFor, agents } from "@/audit/rubrics";
import {
  type GoalConfig,
  type Metric,
  type ResolvedConfig,
  type ScorecardCondition,
  type ScorecardHeader,
  type ScorecardVersion,
  resolveConfig,
  validateGoalConfig,
  validateScorecard,
} from "@/audit/v2/config";
import { QueryTypes, type Sequelize, type Transaction } from "sequelize";

/**
 * Reads and versions the v2 configuration (migration 0003). v2 path only: v1 rubrics stay in code. Takes the
 * connection as an argument, like `createMigrator`, so tests can point it at a throwaway database.
 *
 * Versioning: `create*Draft` copies a published version into version + 1 as a draft (one draft at a time);
 * `publish*` validates the draft and freezes it. The database rejects any change to a published version.
 *
 * Agents: `assignScorecard` points an agent at a published scorecard version without creating a version.
 * Publishing a scorecard draft moves the agents that were on the version it was copied from to the new one.
 *
 * A new agent needs an entry in `agents` (`rubrics/index.ts`), a goal config (`createGoalDraft(..., { from })` +
 * `publishGoalConfig`) and `assignScorecard`.
 */

// NUMERIC comes back from pg as a string; cast to float8 so the types hold.
const SCORECARD =
  "s.scorecard_id, s.version, s.status, s.name, s.based_on, s.pass_threshold::float8 AS pass_threshold, s.fail_score_cap, s.published_at";
const METRIC =
  "id, key, position, name, description, rubric, applicability, method, weight::float8 AS weight, scale, auto_fail, evidence_required, requires, params";
const CONDITION = "condition_code, enabled, severity, metric_key";
const GOAL =
  "agent_code, version, status, name, description, success_criteria, partial_success, not_applicable_when, required_outputs, reason_codes, system_checks, published_at";

const select = <T extends object>(db: Sequelize, sql: string, bind: unknown[], transaction?: Transaction) =>
  db.query<T>(sql, { bind, type: QueryTypes.SELECT, transaction });

function knownAgent(agent_code: string) {
  if (!agents.some((a) => a.code === agent_code))
    throw new Error(`unknown agent ${agent_code}: add it to agents in src/audit/rubrics/index.ts first`);
}

async function withParts(db: Sequelize, header: ScorecardHeader, transaction?: Transaction): Promise<ScorecardVersion> {
  const key = [header.scorecard_id, header.version];
  const where = "WHERE scorecard_id = $1 AND scorecard_version = $2";
  const metrics = await select<Metric>(db, `SELECT ${METRIC} FROM metric ${where} ORDER BY position`, key, transaction);
  const conditions = await select<ScorecardCondition>(
    db,
    `SELECT ${CONDITION} FROM scorecard_condition ${where} ORDER BY condition_code`,
    key,
    transaction,
  );
  return { ...header, metrics, conditions };
}

/** One scorecard version with its metrics (in order) and conditions, or null. */
export async function loadScorecard(db: Sequelize, scorecard_id: string, version: number, transaction?: Transaction) {
  const [header] = await select<ScorecardHeader>(
    db,
    `SELECT ${SCORECARD} FROM scorecard s WHERE s.scorecard_id = $1 AND s.version = $2`,
    [scorecard_id, version],
    transaction,
  );
  return header ? withParts(db, header, transaction) : null;
}

export async function loadGoalConfig(db: Sequelize, agent_code: string, version: number, transaction?: Transaction) {
  const [goal] = await select<GoalConfig>(
    db,
    `SELECT ${GOAL} FROM goal_config WHERE agent_code = $1 AND version = $2`,
    [agent_code, version],
    transaction,
  );
  return goal ?? null;
}

/**
 * P1-3: the scorecard (with metrics and conditions) the call's agent is assigned to, and its goal config, matching
 * the agent on `agent_code` or `agent_id` the same way as `agentFor`. Returns a reason instead when there is none.
 */
export async function loadActiveConfig(
  db: Sequelize,
  agent_code: string | null,
  agent_id: number | null,
): Promise<ResolvedConfig<ScorecardVersion>> {
  const agent = agentFor(agent_code, agent_id);
  if (!agent) return { scorecard: null, goal: null, reason: "unknown_agent" };
  const [assigned] = await select<ScorecardHeader>(
    db,
    `SELECT ${SCORECARD} FROM scorecard_assignment a
       JOIN scorecard s ON s.scorecard_id = a.scorecard_id AND s.version = a.scorecard_version
      WHERE a.agent_code = $1`,
    [agent.code],
  );
  const goals = await select<GoalConfig>(db, `SELECT ${GOAL} FROM goal_config WHERE status = 'published' AND agent_code = $1`, [
    agent.code,
  ]);
  const resolved = resolveConfig(agent, { assigned: assigned ?? null, goals });
  if (resolved.reason !== null) return resolved;
  return { ...resolved, scorecard: await withParts(db, resolved.scorecard) };
}

/** The lineage's draft version, its latest published version, and the next free version number. */
async function versions(db: Sequelize, table: "scorecard" | "goal_config", keyColumn: string, key: string, transaction: Transaction) {
  const [row] = await select<{ draft: number | null; published: number | null; latest: number | null }>(
    db,
    `SELECT max(version) FILTER (WHERE status = 'draft') AS draft, max(version) FILTER (WHERE status = 'published') AS published,
            max(version) AS latest
       FROM ${table} WHERE ${keyColumn} = $1`,
    [key],
    transaction,
  );
  return { draft: row!.draft, published: row!.published, next: (row!.latest ?? 0) + 1 };
}

/**
 * Starts the next version of a scorecard as a draft. It copies the scorecard's latest published version, or `from`
 * (any published version, e.g. of another scorecard, to start a new scorecard at version 1).
 */
export function createScorecardDraft(
  db: Sequelize,
  scorecard_id: string,
  created_by: string,
  opts: { from?: { scorecard_id: string; version: number } } = {},
): Promise<ScorecardVersion> {
  return db.transaction(async (transaction) => {
    const v = await versions(db, "scorecard", "scorecard_id", scorecard_id, transaction);
    if (v.draft !== null) throw new Error(`scorecard ${scorecard_id} already has a draft (version ${v.draft})`);
    const from = opts.from ?? (v.published !== null ? { scorecard_id, version: v.published } : null);
    if (!from) throw new Error(`scorecard ${scorecard_id} has no published version to copy; pass one as from`);
    const source = await loadScorecard(db, from.scorecard_id, from.version, transaction);
    if (source?.status !== "published") throw new Error(`scorecard ${from.scorecard_id} version ${from.version} is not published`);
    // Only a copy within the same scorecard takes that version's agents along when it is published.
    const based_on = from.scorecard_id === scorecard_id ? from.version : null;
    const bind = [from.scorecard_id, from.version, scorecard_id, v.next];
    await db.query(
      `INSERT INTO scorecard (scorecard_id, version, name, based_on, pass_threshold, fail_score_cap, created_by)
       SELECT $3, $4, name, $5, pass_threshold, fail_score_cap, $6 FROM scorecard WHERE scorecard_id = $1 AND version = $2`,
      { bind: [...bind, based_on, created_by], transaction },
    );
    await db.query(
      `INSERT INTO metric (scorecard_id, scorecard_version, key, position, name, description, rubric, applicability, method, weight, scale,
                           auto_fail, evidence_required, requires, params)
       SELECT $3, $4, key, position, name, description, rubric, applicability, method, weight, scale,
              auto_fail, evidence_required, requires, params
         FROM metric WHERE scorecard_id = $1 AND scorecard_version = $2`,
      { bind, transaction },
    );
    await db.query(
      `INSERT INTO scorecard_condition (scorecard_id, scorecard_version, condition_code, enabled, severity, metric_key)
       SELECT $3, $4, condition_code, enabled, severity, metric_key FROM scorecard_condition WHERE scorecard_id = $1 AND scorecard_version = $2`,
      { bind, transaction },
    );
    return (await loadScorecard(db, scorecard_id, v.next, transaction))!;
  });
}

/**
 * Publishes a scorecard's draft as its new version, after `validateScorecard`. From then on it can't change. The
 * agents on the version the draft was copied from move to it; agents on other versions stay where they are.
 */
export function publishScorecard(db: Sequelize, scorecard_id: string, published_by: string): Promise<ScorecardVersion> {
  return db.transaction(async (transaction) => {
    const v = await versions(db, "scorecard", "scorecard_id", scorecard_id, transaction);
    if (v.draft === null) throw new Error(`scorecard ${scorecard_id} has no draft to publish`);
    const draft = (await loadScorecard(db, scorecard_id, v.draft, transaction))!;
    const errors = validateScorecard(draft);
    if (errors.length) throw new Error(`scorecard ${scorecard_id} version ${v.draft} can't be published: ${errors.join("; ")}`);
    await db.query(`UPDATE scorecard SET status = 'published', published_at = now() WHERE scorecard_id = $1 AND version = $2`, {
      bind: [scorecard_id, v.draft],
      transaction,
    });
    if (draft.based_on !== null) {
      await db.query(
        `UPDATE scorecard_assignment SET scorecard_version = $3, assigned_by = $4, assigned_at = now()
          WHERE scorecard_id = $1 AND scorecard_version = $2`,
        { bind: [scorecard_id, draft.based_on, v.draft, published_by], transaction },
      );
    }
    return (await loadScorecard(db, scorecard_id, v.draft, transaction))!;
  });
}

/** Points an agent at a published scorecard version. Creates no version; earlier audits keep the version they used. */
export async function assignScorecard(db: Sequelize, agent_code: string, scorecard_id: string, version: number, assigned_by: string) {
  knownAgent(agent_code);
  await db.query(
    `INSERT INTO scorecard_assignment (agent_code, scorecard_id, scorecard_version, assigned_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (agent_code) DO UPDATE
       SET scorecard_id = EXCLUDED.scorecard_id, scorecard_version = EXCLUDED.scorecard_version,
           assigned_by = EXCLUDED.assigned_by, assigned_at = now()`,
    { bind: [agent_code, scorecard_id, version, assigned_by] },
  );
}

/**
 * Starts the next version of an agent's goal config as a draft, copied from its latest published version, or from
 * another agent's (`from`, e.g. for a new agent's first goal config).
 */
export function createGoalDraft(db: Sequelize, agent_code: string, created_by: string, opts: { from?: string } = {}): Promise<GoalConfig> {
  return db.transaction(async (transaction) => {
    knownAgent(agent_code);
    const v = await versions(db, "goal_config", "agent_code", agent_code, transaction);
    if (v.draft !== null) throw new Error(`goal config for ${agent_code} already has a draft (version ${v.draft})`);
    const fromAgent = opts.from ?? agent_code;
    const fromVersion =
      fromAgent === agent_code ? v.published : (await versions(db, "goal_config", "agent_code", fromAgent, transaction)).published;
    if (fromVersion === null) throw new Error(`goal config for ${fromAgent} has no published version to copy; pass another agent as from`);
    await db.query(
      `INSERT INTO goal_config (agent_code, version, name, description, success_criteria, partial_success, not_applicable_when,
                                required_outputs, reason_codes, system_checks, created_by)
       SELECT $3, $4, name, description, success_criteria, partial_success, not_applicable_when, required_outputs,
              reason_codes, system_checks, $5
         FROM goal_config WHERE agent_code = $1 AND version = $2`,
      { bind: [fromAgent, fromVersion, agent_code, v.next, created_by], transaction },
    );
    return (await loadGoalConfig(db, agent_code, v.next, transaction))!;
  });
}

/** Publishes an agent's goal config draft as its new version, after `validateGoalConfig`. */
export function publishGoalConfig(db: Sequelize, agent_code: string): Promise<GoalConfig> {
  return db.transaction(async (transaction) => {
    const v = await versions(db, "goal_config", "agent_code", agent_code, transaction);
    if (v.draft === null) throw new Error(`goal config for ${agent_code} has no draft to publish`);
    const draft = (await loadGoalConfig(db, agent_code, v.draft, transaction))!;
    const errors = validateGoalConfig(draft);
    if (errors.length) throw new Error(`goal config for ${agent_code} version ${v.draft} can't be published: ${errors.join("; ")}`);
    await db.query(`UPDATE goal_config SET status = 'published', published_at = now() WHERE agent_code = $1 AND version = $2`, {
      bind: [agent_code, v.draft],
      transaction,
    });
    return (await loadGoalConfig(db, agent_code, v.draft, transaction))!;
  });
}

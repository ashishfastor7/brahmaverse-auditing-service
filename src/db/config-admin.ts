import { agents } from "@/audit/rubrics";
import { NEEDS_DATA } from "@/audit/v2/conditions";
import {
  type GoalConfig,
  MIN_METRICS,
  type ScorecardVersion,
  validateGoalConfig,
  validateScorecard,
} from "@/audit/v2/config";
import { type ConfigChange, diffGoal, diffScorecard } from "@/audit/v2/config-diff";
import { type GoalPatch, type ScorecardPatch, applyGoalEdit, applyScorecardEdit } from "@/audit/v2/config-edit";
import { GOAL_TEMPLATES } from "@/audit/v2/goal-templates";
import type { MetricResult } from "@/audit/v2/score";
import type { Flag } from "@/audit/v2/severity";
import { type Simulation, type StoredAudit, simulateScorecard } from "@/audit/v2/simulate";
import { QueryTypes, type Sequelize, type Transaction } from "sequelize";
import {
  type ConfigAction,
  type ConfigEntity,
  createGoalDraft,
  createScorecardDraft,
  loadGoalConfig,
  loadScorecard,
  logChange,
  publishGoalConfig,
} from "./config-store";

/**
 * The scorecard and goal admin screens (P1-18, P1-20; PRD §3.2, §4, §8 #3, §8 #14): list, start, edit, publish and
 * discard drafts, version history from the change log, and the scorecard simulation. v2 only. Edits are checked by the
 * pure `applyScorecardEdit` / `applyGoalEdit`; publishing still goes through `publishScorecard` / `publishGoalConfig`.
 */

/** Why a request can't be done; the route answers with `status`. */
export class ConfigError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
  }
}

const select = <T extends object>(db: Sequelize, sql: string, bind: unknown[] = [], transaction?: Transaction) =>
  db.query<T>(sql, { bind, type: QueryTypes.SELECT, transaction });

type Versions = { published: number | null; draft: number | null };
async function versionsOf(db: Sequelize, entity: ConfigEntity, key: string, transaction?: Transaction): Promise<Versions> {
  const [table, column] = entity === "scorecard" ? ["scorecard", "scorecard_id"] : ["goal_config", "agent_code"];
  const [row] = await select<Versions>(
    db,
    `SELECT max(version) FILTER (WHERE status = 'published') AS published, max(version) FILTER (WHERE status = 'draft') AS draft
       FROM ${table} WHERE ${column} = $1`,
    [key],
    transaction,
  );
  return row ?? { published: null, draft: null };
}

type Meta = { version: number; status: "draft" | "published"; created_by: string | null; created_at: Date; published_at: Date | null };
const metaOf = (db: Sequelize, entity: ConfigEntity, key: string) =>
  entity === "scorecard"
    ? select<Meta>(db, "SELECT version, status, created_by, created_at, published_at FROM scorecard WHERE scorecard_id = $1 ORDER BY version DESC", [key])
    : select<Meta>(db, "SELECT version, status, created_by, created_at, published_at FROM goal_config WHERE agent_code = $1 ORDER BY version DESC", [key]);

const agentsOn = async (db: Sequelize, scorecard_id: string, version: number) =>
  (
    await select<{ agent_code: string }>(
      db,
      "SELECT agent_code FROM scorecard_assignment WHERE scorecard_id = $1 AND scorecard_version = $2 ORDER BY agent_code",
      [scorecard_id, version],
    )
  ).map((a) => a.agent_code);

const agentLabel = (code: string) => agents.find((a) => a.code === code)?.label ?? code;

// ---------------------------------------------------------------------------------------------------------------------
// Scorecards

export type ScorecardSummary = {
  scorecard_id: string;
  name: string;
  published: number;
  published_at: Date | null;
  draft: number | null;
  /** How many fields the draft changes compared with the version it was copied from. */
  draft_changes: number;
  agents: { code: string; label: string }[];
};

/** Every scorecard agents can use (at least `MIN_METRICS` metrics; the 5 × 20 v1 templates are left out). */
export async function listAdminScorecards(db: Sequelize): Promise<ScorecardSummary[]> {
  const ids = await select<{ scorecard_id: string }>(db, "SELECT DISTINCT scorecard_id FROM scorecard ORDER BY scorecard_id");
  const out: ScorecardSummary[] = [];
  for (const { scorecard_id } of ids) {
    const admin = await loadScorecardAdmin(db, scorecard_id).catch((e) => (e instanceof ConfigError ? null : Promise.reject(e)));
    if (!admin) continue;
    out.push({
      scorecard_id,
      name: admin.published.name,
      published: admin.published.version,
      published_at: admin.published.published_at,
      draft: admin.draft?.version ?? null,
      draft_changes: admin.changes.length,
      agents: admin.agents,
    });
  }
  return out;
}

export type ScorecardAdmin = {
  scorecard_id: string;
  agents: { code: string; label: string }[];
  /** The latest published version, which agents use. */
  published: ScorecardVersion;
  draft: (ScorecardVersion & { created_by: string | null; created_at: Date }) | null;
  /** The version the draft was copied from (its agents move to the draft when it is published). */
  base: number | null;
  /** What the draft changes compared with its base version. */
  changes: ConfigChange[];
  /** Why the draft can't be published yet; empty when it can. */
  publish_errors: string[];
  /** Library wording of the scorecard's conditions, and why some can't be switched on. */
  library: { code: string; label: string; definition: string; detection: "rule" | "llm"; needs_data: string | null }[];
};

/** One scorecard for its editor: the published version, the draft and what it changes. 404 for an unknown one. */
export async function loadScorecardAdmin(db: Sequelize, scorecard_id: string): Promise<ScorecardAdmin> {
  const v = await versionsOf(db, "scorecard", scorecard_id);
  if (v.published === null) throw new ConfigError(`no scorecard ${scorecard_id}`, 404);
  const published = (await loadScorecard(db, scorecard_id, v.published))!;
  if (published.metrics.length < MIN_METRICS) throw new ConfigError(`scorecard ${scorecard_id} is a v1 template; it can't be edited here`, 404);
  const draftVersion = v.draft === null ? null : (await loadScorecard(db, scorecard_id, v.draft))!;
  const [meta] = v.draft === null ? [] : await select<{ created_by: string | null; created_at: Date }>(
    db,
    "SELECT created_by, created_at FROM scorecard WHERE scorecard_id = $1 AND version = $2",
    [scorecard_id, v.draft],
  );
  const base = draftVersion?.based_on ?? null;
  const baseVersion = base === null || base === published.version ? published : (await loadScorecard(db, scorecard_id, base))!;
  const codes = [...new Set([...published.conditions, ...(draftVersion?.conditions ?? [])].map((c) => c.condition_code))];
  const library = await select<{ code: string; label: string; definition: string; detection: "rule" | "llm" }>(
    db,
    "SELECT code, label, definition, detection FROM failure_condition WHERE code = ANY($1) ORDER BY code",
    [codes],
  );
  return {
    scorecard_id,
    agents: (await agentsOn(db, scorecard_id, published.version)).map((code) => ({ code, label: agentLabel(code) })),
    published,
    draft: draftVersion && meta ? { ...draftVersion, ...meta } : null,
    base,
    changes: draftVersion ? diffScorecard(baseVersion, draftVersion) : [],
    publish_errors: draftVersion ? validateScorecard(draftVersion) : [],
    library: library.map((l) => ({ ...l, needs_data: NEEDS_DATA[l.code] ?? null })),
  };
}

/** The metric fields an admin can edit, for telling whether a row needs writing. */
const editable = (m: ScorecardVersion["metrics"][number]) => JSON.stringify([m.name, m.description, m.rubric, m.applicability, m.auto_fail, m.weight]);

/** Starts the next version as a draft, copied from the latest published one. 409 when a draft already exists. */
export async function startScorecardDraft(db: Sequelize, scorecard_id: string, by: string): Promise<ScorecardAdmin> {
  await loadScorecardAdmin(db, scorecard_id); // 404s
  const v = await versionsOf(db, "scorecard", scorecard_id);
  if (v.draft !== null) throw new ConfigError(`scorecard ${scorecard_id} already has a draft (version ${v.draft})`, 409);
  await createScorecardDraft(db, scorecard_id, by);
  return loadScorecardAdmin(db, scorecard_id);
}

/**
 * Saves edits to a scorecard's draft (`applyScorecardEdit`) and logs what changed. 404 without a draft, 400 for an
 * edit it can't take. Nothing is published.
 */
export async function updateScorecardDraft(db: Sequelize, scorecard_id: string, patch: ScorecardPatch, by: string): Promise<ScorecardAdmin> {
  await db.transaction(async (transaction) => {
    const v = await versionsOf(db, "scorecard", scorecard_id, transaction);
    if (v.draft === null) throw new ConfigError(`scorecard ${scorecard_id} has no draft; start one first`, 404);
    const draft = (await loadScorecard(db, scorecard_id, v.draft, transaction))!;
    const edited = applyScorecardEdit(draft, patch);
    if (!edited.value) throw new ConfigError(edited.errors.join("; "), 400);
    const next = edited.value;
    const changes = diffScorecard(draft, next);
    if (changes.length === 0) return;

    const key = [scorecard_id, v.draft];
    await db.query("UPDATE scorecard SET pass_threshold = $3 WHERE scorecard_id = $1 AND version = $2", {
      bind: [...key, next.pass_threshold],
      transaction,
    });
    for (const m of next.metrics) {
      if (editable(draft.metrics.find((x) => x.key === m.key)!) === editable(m)) continue;
      await db.query(
        `UPDATE metric SET name = $4, description = $5, rubric = $6, applicability = $7, auto_fail = $8, weight = $9
          WHERE scorecard_id = $1 AND scorecard_version = $2 AND key = $3`,
        { bind: [...key, m.key, m.name, m.description, JSON.stringify(m.rubric), m.applicability, m.auto_fail, m.weight], transaction },
      );
    }
    for (const c of next.conditions) {
      const before = draft.conditions.find((x) => x.condition_code === c.condition_code)!;
      if (before.enabled === c.enabled && before.severity === c.severity && before.metric_key === c.metric_key) continue;
      await db.query(
        `UPDATE scorecard_condition SET enabled = $4, severity = $5, metric_key = $6
          WHERE scorecard_id = $1 AND scorecard_version = $2 AND condition_code = $3`,
        { bind: [...key, c.condition_code, c.enabled, c.severity, c.metric_key], transaction },
      );
    }
    await logChange(db, { entity: "scorecard", key: scorecard_id, version: v.draft, action: "edited", changes, by }, transaction);
  });
  return loadScorecardAdmin(db, scorecard_id);
}

/** Most audits a simulation re-scores. */
export const SIMULATION_MAX = 500;

/**
 * P1-20: re-scores the scorecard's last `n` current, completed v2 audits from their stored metric results and flags,
 * with the draft's base version and with the draft (`simulateScorecard`). No judge call, nothing written. 404 without a
 * draft.
 */
export async function simulateDraft(db: Sequelize, scorecard_id: string, n: number): Promise<Simulation & { requested: number }> {
  const admin = await loadScorecardAdmin(db, scorecard_id);
  if (!admin.draft) throw new ConfigError(`scorecard ${scorecard_id} has no draft to simulate`, 404);
  const limit = Math.min(Math.max(Math.trunc(n) || 100, 1), SIMULATION_MAX);
  const base = admin.base === null || admin.base === admin.published.version ? admin.published : (await loadScorecard(db, scorecard_id, admin.base))!;

  const rows = await select<{ id: number; call_id: number }>(
    db,
    `SELECT id, call_id FROM audit_results
      WHERE engine = 'v2' AND status = 'completed' AND superseded_by IS NULL AND scorecard_id = $1
      ORDER BY created_at DESC, id DESC LIMIT $2`,
    [scorecard_id, limit],
  );
  const ids = rows.map((r) => r.id);
  const results = await select<MetricResult & { audit_id: number }>(
    db,
    `SELECT r.audit_id, m.key, r.score::float8 AS score, r.max::float8 AS max, r.n_a
       FROM metric_result r JOIN metric m ON m.id = r.metric_id WHERE r.audit_id = ANY($1)`,
    [ids],
  );
  const flags = await select<Flag & { audit_id: number }>(
    db,
    "SELECT audit_id, condition_code AS code, source, evidence FROM failure_flag WHERE audit_id = ANY($1) ORDER BY id",
    [ids],
  );
  const audits: StoredAudit[] = rows.map((r) => ({
    id: r.id,
    call_id: r.call_id,
    results: results.filter((x) => x.audit_id === r.id).map(({ audit_id: _, ...m }) => m),
    flags: flags.filter((x) => x.audit_id === r.id).map(({ audit_id: _, ...f }) => f),
  }));
  return { ...simulateScorecard(audits, base, admin.draft), requested: limit };
}

// ---------------------------------------------------------------------------------------------------------------------
// History

export type HistoryEntry = {
  version: number;
  status: "draft" | "published";
  created_by: string | null;
  created_at: Date;
  published_at: Date | null;
  /** Who published it: the log's `published` entry, else who created it (`migration` for the seeded versions). */
  published_by: string | null;
  /** What this version changed compared with the one before it. */
  changes: ConfigChange[];
  /** The change log for this version, oldest first: draft started, each save, published. */
  log: { action: ConfigAction; changes: ConfigChange[]; changed_by: string; changed_at: Date }[];
};

async function history<V>(
  db: Sequelize,
  entity: ConfigEntity,
  key: string,
  load: (version: number) => Promise<V>,
  diff: (before: V, after: V) => ConfigChange[],
): Promise<HistoryEntry[]> {
  const metas = await metaOf(db, entity, key);
  const log = await select<{ version: number; action: ConfigAction; changes: ConfigChange[]; changed_by: string; changed_at: Date }>(
    db,
    "SELECT version, action, changes, changed_by, changed_at FROM config_change WHERE entity = $1 AND config_key = $2 ORDER BY id",
    [entity, key],
  );
  const loaded = new Map<number, V>();
  for (const m of metas) loaded.set(m.version, await load(m.version));
  return metas.map((m) => {
    // A discarded draft's number is reused by the next one: keep only this draft's entries, from its last start.
    const mine = log.filter((l) => l.version === m.version);
    const start = mine.map((l) => l.action).lastIndexOf("draft_created");
    const entries = (start < 0 ? mine : mine.slice(start)).filter((l) => l.action !== "discarded");
    const previous = metas.find((p) => p.version < m.version && p.status === "published");
    return {
      ...m,
      published_by: m.status === "published" ? (entries.find((l) => l.action === "published")?.changed_by ?? m.created_by) : null,
      changes: previous ? diff(loaded.get(previous.version)!, loaded.get(m.version)!) : [],
      log: entries.map(({ version: _, ...l }) => l),
    };
  });
}

/** Every version of a scorecard, newest first, with what each changed and who did it. */
export async function scorecardHistory(db: Sequelize, scorecard_id: string): Promise<HistoryEntry[]> {
  await loadScorecardAdmin(db, scorecard_id); // 404s
  return history(db, "scorecard", scorecard_id, async (v) => (await loadScorecard(db, scorecard_id, v))!, diffScorecard);
}

// ---------------------------------------------------------------------------------------------------------------------
// Goals

export type GoalAdmin = {
  agent_code: string;
  label: string;
  published: GoalConfig | null;
  draft: (GoalConfig & { created_by: string | null; created_at: Date }) | null;
  changes: ConfigChange[];
  publish_errors: string[];
};

function knownAgent(agent_code: string) {
  if (!agents.some((a) => a.code === agent_code)) throw new ConfigError(`no agent ${agent_code}`, 404);
}

/** One agent's business goal for its editor: the published version, the draft and what it changes. */
export async function loadGoalAdmin(db: Sequelize, agent_code: string): Promise<GoalAdmin> {
  knownAgent(agent_code);
  const v = await versionsOf(db, "goal_config", agent_code);
  const published = v.published === null ? null : await loadGoalConfig(db, agent_code, v.published);
  const draft = v.draft === null ? null : await loadGoalConfig(db, agent_code, v.draft);
  const [meta] = v.draft === null ? [] : await select<{ created_by: string | null; created_at: Date }>(
    db,
    "SELECT created_by, created_at FROM goal_config WHERE agent_code = $1 AND version = $2",
    [agent_code, v.draft],
  );
  return {
    agent_code,
    label: agentLabel(agent_code),
    published,
    draft: draft && meta ? { ...draft, ...meta } : null,
    changes: draft && published ? diffGoal(published, draft) : [],
    publish_errors: draft ? validateGoalConfig(draft) : [],
  };
}

/** Every agent's goal: its published and draft versions. */
export async function listGoals(db: Sequelize) {
  const out = [];
  for (const a of agents) {
    const g = await loadGoalAdmin(db, a.code);
    out.push({
      agent_code: a.code,
      label: a.label,
      name: (g.draft ?? g.published)?.name ?? null,
      published: g.published?.version ?? null,
      published_at: g.published?.published_at ?? null,
      draft: g.draft?.version ?? null,
      draft_changes: g.changes.length,
    });
  }
  return out;
}

/**
 * Starts the agent's next goal version as a draft, copied from its published one. With `template`, the business goal
 * fields then come from that starter template (`GOAL_TEMPLATES`), saved as an edit; the system goal settings stay.
 */
export async function startGoalDraft(db: Sequelize, agent_code: string, by: string, template?: string): Promise<GoalAdmin> {
  knownAgent(agent_code);
  const picked = template === undefined ? null : GOAL_TEMPLATES.find((t) => t.id === template);
  if (picked === undefined) throw new ConfigError(`no goal template ${template}`, 400);
  const v = await versionsOf(db, "goal_config", agent_code);
  if (v.draft !== null) throw new ConfigError(`the goal for ${agent_code} already has a draft (version ${v.draft})`, 409);
  if (v.published === null) throw new ConfigError(`${agent_code} has no published goal to copy`, 409);
  await createGoalDraft(db, agent_code, by);
  if (picked) {
    const { id: _, ...fields } = picked;
    // Every outcome is set, so a template without Partial clears the copied Partial codes.
    await updateGoalDraft(db, agent_code, { ...fields, reason_codes: { PARTIAL: [], NOT_APPLICABLE: [], ...fields.reason_codes } }, by);
  }
  return loadGoalAdmin(db, agent_code);
}

/** Saves edits to an agent's goal draft (`applyGoalEdit`) and logs what changed. 404 without a draft, 400 for a bad edit. */
export async function updateGoalDraft(db: Sequelize, agent_code: string, patch: GoalPatch, by: string): Promise<GoalAdmin> {
  knownAgent(agent_code);
  await db.transaction(async (transaction) => {
    const v = await versionsOf(db, "goal_config", agent_code, transaction);
    if (v.draft === null) throw new ConfigError(`the goal for ${agent_code} has no draft; start one first`, 404);
    const draft = (await loadGoalConfig(db, agent_code, v.draft, transaction))!;
    const edited = applyGoalEdit(draft, patch);
    if (!edited.value) throw new ConfigError(edited.errors.join("; "), 400);
    const g = edited.value;
    const changes = diffGoal(draft, g);
    if (changes.length === 0) return;
    await db.query(
      `UPDATE goal_config SET name = $3, description = $4, success_criteria = $5, partial_success = $6, not_applicable_when = $7,
              required_outputs = $8, reason_codes = $9, system_checks = $10
        WHERE agent_code = $1 AND version = $2`,
      {
        bind: [
          agent_code,
          v.draft,
          g.name,
          g.description,
          g.success_criteria,
          g.partial_success,
          g.not_applicable_when,
          g.required_outputs,
          JSON.stringify(g.reason_codes),
          JSON.stringify(g.system_checks),
        ],
        transaction,
      },
    );
    await logChange(db, { entity: "goal_config", key: agent_code, version: v.draft, action: "edited", changes, by }, transaction);
  });
  return loadGoalAdmin(db, agent_code);
}

/** Publishes the agent's goal draft as its new version. 404 without a draft, 400 when it isn't complete. */
export async function publishGoal(db: Sequelize, agent_code: string, by: string): Promise<GoalAdmin> {
  const admin = await loadGoalAdmin(db, agent_code);
  if (!admin.draft) throw new ConfigError(`the goal for ${agent_code} has no draft to publish`, 404);
  if (admin.publish_errors.length) throw new ConfigError(`it can't be published yet: ${admin.publish_errors.join("; ")}`, 400);
  await publishGoalConfig(db, agent_code, by);
  return loadGoalAdmin(db, agent_code);
}

/** Throws away the agent's goal draft. 404 without one. */
export async function discardGoalDraft(db: Sequelize, agent_code: string, by: string): Promise<void> {
  knownAgent(agent_code);
  await db.transaction(async (transaction) => {
    const deleted = await select<{ version: number }>(
      db,
      "DELETE FROM goal_config WHERE agent_code = $1 AND status = 'draft' RETURNING version",
      [agent_code],
      transaction,
    );
    if (!deleted.length) throw new ConfigError(`the goal for ${agent_code} has no draft to discard`, 404);
    await logChange(db, { entity: "goal_config", key: agent_code, version: deleted[0]!.version, action: "discarded", by }, transaction);
  });
}

/** Every version of an agent's goal, newest first, with what each changed and who did it. */
export async function goalHistory(db: Sequelize, agent_code: string): Promise<HistoryEntry[]> {
  knownAgent(agent_code);
  return history(db, "goal_config", agent_code, async (v) => (await loadGoalConfig(db, agent_code, v))!, diffGoal);
}

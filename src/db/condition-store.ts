import { CODE_PATTERN, codeFromLabel, withDoesNotCount } from "@/audit/v2/conditions";
import { MIN_METRICS, type ScorecardCondition, type Severity, validateScorecard } from "@/audit/v2/config";
import { QueryTypes, type Sequelize } from "sequelize";
import { createScorecardDraft, loadScorecard, publishScorecard } from "./config-store";

/**
 * The failure-condition screen (PRD §4.5): the shared library, and adding a condition to it and to scorecard drafts.
 * A condition only counts once its scorecard's draft is published as a new version (`publishDraft`), because published
 * versions never change. v2 only; v1 rubrics keep their own conditions.
 */

/** Why a request can't be done; the route answers with `status`. */
export class ConditionError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
  }
}

export type LibraryRow = {
  code: string;
  label: string;
  definition: string;
  default_severity: Severity;
  rolls_up_to: string[];
  detection: "rule" | "llm";
  created_at: Date;
};

/** A scorecard agents can use, with its published conditions and what its draft would change. */
export type ScorecardConditions = {
  scorecard_id: string;
  name: string;
  published: number;
  draft: number | null;
  agents: string[];
  metrics: { key: string; name: string }[];
  conditions: ScorecardCondition[];
  /** Conditions the draft adds or changes compared with the published version. */
  pending: ScorecardCondition[];
};

const select = <T extends object>(db: Sequelize, sql: string, bind: unknown[] = []) =>
  db.query<T>(sql, { bind, type: QueryTypes.SELECT });

/** The library, and every scorecard with at least 10 metrics (the 5 × 20 v1 templates are left out). */
export async function listConditions(db: Sequelize): Promise<{ conditions: LibraryRow[]; scorecards: ScorecardConditions[] }> {
  const conditions = await select<LibraryRow>(
    db,
    "SELECT code, label, definition, default_severity, rolls_up_to, detection, created_at FROM failure_condition ORDER BY created_at, code",
  );
  const lineages = await select<{ scorecard_id: string; published: number | null; draft: number | null }>(
    db,
    `SELECT scorecard_id, max(version) FILTER (WHERE status = 'published') AS published, max(version) FILTER (WHERE status = 'draft') AS draft
       FROM scorecard GROUP BY scorecard_id ORDER BY scorecard_id`,
  );
  const scorecards: ScorecardConditions[] = [];
  for (const l of lineages) {
    if (l.published === null) continue;
    const published = (await loadScorecard(db, l.scorecard_id, l.published))!;
    if (published.metrics.length < MIN_METRICS) continue;
    const draft = l.draft === null ? null : await loadScorecard(db, l.scorecard_id, l.draft);
    const agents = await select<{ agent_code: string }>(
      db,
      "SELECT agent_code FROM scorecard_assignment WHERE scorecard_id = $1 AND scorecard_version = $2 ORDER BY agent_code",
      [l.scorecard_id, l.published],
    );
    const same = (a: ScorecardCondition, b: ScorecardCondition) =>
      a.enabled === b.enabled && a.severity === b.severity && a.metric_key === b.metric_key;
    scorecards.push({
      scorecard_id: l.scorecard_id,
      name: published.name,
      published: l.published,
      draft: l.draft,
      agents: agents.map((a) => a.agent_code),
      metrics: published.metrics.map((m) => ({ key: m.key, name: m.name })),
      conditions: published.conditions,
      pending: (draft?.conditions ?? []).filter((c) => {
        const before = published.conditions.find((p) => p.condition_code === c.condition_code);
        return !before || !same(before, c);
      }),
    });
  }
  return { conditions, scorecards };
}

export type NewCondition = {
  /** Defaults to the label in upper snake case. */
  code?: string;
  label: string;
  /** What the condition flags. */
  flags_when: string;
  /** The exception that keeps false positives down (PRD §4.5: every definition states what does not count). */
  does_not_count: string;
  severity: Severity;
  /** The metric a Major flag sets to 0; required for Major. */
  metric_key?: string | null;
  scorecards: string[];
};

/**
 * Adds a condition to the library and to the draft of each scorecard in `scorecards` (a draft is started from the
 * latest published version when there is none), all in one transaction. Nothing is published.
 */
export async function addCondition(db: Sequelize, input: NewCondition, created_by: string): Promise<LibraryRow> {
  const code = (input.code?.trim() || codeFromLabel(input.label)).toUpperCase();
  if (!CODE_PATTERN.test(code)) throw new ConditionError(`code ${code || "(empty)"} must be 3–64 capital letters, digits or _`, 400);
  if (input.scorecards.length === 0) throw new ConditionError("pick at least one scorecard", 400);
  const metric_key = input.metric_key || null;
  if (input.severity === "major" && !metric_key) throw new ConditionError("a Major condition needs the metric it sets to 0", 400);

  return db.transaction(async (transaction) => {
    const q = <T extends object>(sql: string, bind: unknown[]) => db.query<T>(sql, { bind, type: QueryTypes.SELECT, transaction });
    if ((await q("SELECT 1 FROM failure_condition WHERE code = $1", [code])).length)
      throw new ConditionError(`a condition with code ${code} already exists`, 409);

    const drafts: { scorecard_id: string; version: number; metricName: string | null }[] = [];
    for (const scorecard_id of [...new Set(input.scorecards)]) {
      const [v] = await q<{ draft: number | null; published: number | null }>(
        `SELECT max(version) FILTER (WHERE status = 'draft') AS draft, max(version) FILTER (WHERE status = 'published') AS published
           FROM scorecard WHERE scorecard_id = $1`,
        [scorecard_id],
      );
      if (v?.published == null) throw new ConditionError(`unknown scorecard ${scorecard_id}`, 404);
      const draft =
        v.draft !== null
          ? (await loadScorecard(db, scorecard_id, v.draft, transaction))!
          : await createScorecardDraft(db, scorecard_id, created_by, { transaction });
      if (draft.metrics.length < MIN_METRICS) throw new ConditionError(`scorecard ${scorecard_id} has fewer than ${MIN_METRICS} metrics`, 400);
      const metric = metric_key ? draft.metrics.find((m) => m.key === metric_key) : null;
      if (metric_key && !metric) throw new ConditionError(`scorecard ${scorecard_id} has no metric ${metric_key}`, 400);
      drafts.push({ scorecard_id, version: draft.version, metricName: metric?.name ?? null });
    }

    const rolls_up_to = drafts[0]!.metricName ? [drafts[0]!.metricName] : [];
    const [row] = await q<LibraryRow>(
      `INSERT INTO failure_condition (code, label, definition, default_severity, rolls_up_to, detection)
       VALUES ($1, $2, $3, $4, $5, 'llm') RETURNING code, label, definition, default_severity, rolls_up_to, detection, created_at`,
      [code, input.label.trim(), withDoesNotCount(input.flags_when, input.does_not_count), input.severity, rolls_up_to],
    );
    for (const d of drafts) {
      await db.query(
        `INSERT INTO scorecard_condition (scorecard_id, scorecard_version, condition_code, enabled, severity, metric_key)
         VALUES ($1, $2, $3, true, $4, $5)`,
        { bind: [d.scorecard_id, d.version, code, input.severity, metric_key], transaction },
      );
    }
    return row!;
  });
}

/**
 * Removes a condition that no published scorecard uses: from the drafts that have it and from the library (e.g. to
 * fix a typo before publishing). One a published version uses stays; a later version can disable it instead.
 */
export async function deleteCondition(db: Sequelize, code: string): Promise<void> {
  await db.transaction(async (transaction) => {
    const q = <T extends object>(sql: string) => db.query<T>(sql, { bind: [code], type: QueryTypes.SELECT, transaction });
    if (!(await q("SELECT 1 FROM failure_condition WHERE code = $1")).length) throw new ConditionError(`no condition ${code}`, 404);
    const used = await q<{ scorecard_id: string; version: number }>(
      `SELECT s.scorecard_id, s.version FROM scorecard_condition c JOIN scorecard s ON s.scorecard_id = c.scorecard_id
          AND s.version = c.scorecard_version WHERE c.condition_code = $1 AND s.status = 'published' ORDER BY 1, 2`,
    );
    if (used.length)
      throw new ConditionError(
        `${code} is used by published ${used.map((u) => `${u.scorecard_id} v${u.version}`).join(", ")}, so it can't be removed`,
        409,
      );
    await db.query("DELETE FROM scorecard_condition WHERE condition_code = $1", { bind: [code], transaction });
    await db.query("DELETE FROM failure_condition WHERE code = $1", { bind: [code], transaction });
  });
}

/** Publishes a scorecard's draft as its new version; the agents on the version it was copied from move to it. */
export async function publishDraft(db: Sequelize, scorecard_id: string, published_by: string) {
  const [v] = await select<{ draft: number | null }>(
    db,
    "SELECT max(version) FILTER (WHERE status = 'draft') AS draft FROM scorecard WHERE scorecard_id = $1",
    [scorecard_id],
  );
  if (v?.draft == null) throw new ConditionError(`scorecard ${scorecard_id} has no draft to publish`, 404);
  const errors = validateScorecard((await loadScorecard(db, scorecard_id, v.draft))!);
  if (errors.length) throw new ConditionError(`scorecard ${scorecard_id} version ${v.draft} can't be published: ${errors.join("; ")}`, 400);
  return publishScorecard(db, scorecard_id, published_by);
}

/** Throws away a scorecard's draft, with its metrics and conditions. Library conditions stay. */
export async function discardDraft(db: Sequelize, scorecard_id: string): Promise<void> {
  const deleted = await select(db, "DELETE FROM scorecard WHERE scorecard_id = $1 AND status = 'draft' RETURNING version", [scorecard_id]);
  if (!deleted.length) throw new ConditionError(`scorecard ${scorecard_id} has no draft to discard`, 404);
}

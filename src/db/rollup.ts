import {
  type AuditRollup,
  type CallRollup,
  type CallStatusGroup,
  type RescoreScorecard,
  type RollupAudit,
  buildAuditRollups,
  buildCallRollups,
  istDay,
  istDayRange,
  rescoreForRollup,
  rollupAgent,
} from "@/audit/v2/rollup";
import type { Flag } from "@/audit/v2/severity";
import { QueryTypes, type Sequelize, type Transaction } from "sequelize";
import { loadScorecard } from "./config-store";

/**
 * P2-6 roll-ups (PRD §6, §7): `daily_rollup` (current v2 audits per IST day of the call, agent and scorecard version)
 * and `daily_call_rollup` (source call counts per IST day and agent). Every refresh recomputes whole days from the raw
 * rows, so a re-audit that moves a call to another scorecard version or agent leaves nothing stale. Aggregation only:
 * nothing here ever runs an audit.
 *
 * - `refreshAuditDays`: after an audit is written or superseded (`runAuditV2`), or re-scored.
 * - `refreshCallDays` / `rebuildAllRollups`: the nightly job and `bun run rollup:rebuild`. Call counts come from the
 *   read-only source DB, passed in as `source`.
 */

/** All roll-up writes take this one transaction lock (two-key form, so it never meets `runAuditV2`'s per-call lock). */
const LOCK = "SELECT pg_advisory_xact_lock(2606, 0)";

/** A current audit: the call's latest completed v2 audit. */
const CURRENT = `engine = 'v2' AND status = 'completed' AND superseded_by IS NULL AND call_created_at IS NOT NULL AND scorecard_id IS NOT NULL`;

const select = <T extends object>(db: Sequelize, sql: string, bind: unknown[], transaction?: Transaction) =>
  db.query<T>(sql, { bind, type: QueryTypes.SELECT, transaction });

const uniqueDays = (days: string[]) => [...new Set(days)].sort();

/** Each agent's assigned scorecard (the one weight set the re-scored numbers use), by agent code. */
async function assignedScorecards(db: Sequelize, transaction: Transaction): Promise<Map<string, RescoreScorecard>> {
  const rows = await select<{ agent_code: string; scorecard_id: string; scorecard_version: number }>(
    db,
    "SELECT agent_code, scorecard_id, scorecard_version FROM scorecard_assignment",
    [],
    transaction,
  );
  const out = new Map<string, RescoreScorecard>();
  for (const r of rows) {
    const scorecard = await loadScorecard(db, r.scorecard_id, r.scorecard_version, transaction);
    if (scorecard) out.set(r.agent_code, scorecard);
  }
  return out;
}

/** Rows of `table` for these audits, grouped by audit id. */
async function byAuditId<T extends { audit_id: number }>(db: Sequelize, sql: string, ids: number[], transaction: Transaction) {
  const rows = await select<T>(db, sql, [ids], transaction);
  const out = new Map<number, T[]>();
  for (const r of rows) out.set(r.audit_id, [...(out.get(r.audit_id) ?? []), r]);
  return out;
}

/**
 * Current audits with their metric results, checks and the re-scored result, for the given IST days (every day when
 * `days` is null).
 */
async function loadAudits(db: Sequelize, days: string[] | null, transaction: Transaction): Promise<RollupAudit[]> {
  const ranges = days?.map(istDayRange);
  const bind: unknown[] = [];
  let where = CURRENT;
  if (ranges) {
    const parts = ranges.map((r) => {
      bind.push(r.from, r.to);
      return `(call_created_at >= $${bind.length - 1} AND call_created_at < $${bind.length})`;
    });
    where += ` AND (${parts.join(" OR ")})`;
  }
  const audits = await select<Omit<RollupAudit, "metrics"> & { id: number }>(
    db,
    `SELECT id, call_created_at, agent_code, agent_id, call->>'call_type' AS direction, goal_version, trigger_mode,
            business_reason, scorecard_id, scorecard_version, score::float8 AS score, success_result,
            system_goal, business_goal, failure_codes, needs_review
       FROM audit_results WHERE ${where}`,
    bind,
    transaction,
  );
  if (!audits.length) return [];
  const ids = audits.map((a) => a.id);
  const metrics = await byAuditId<{ audit_id: number; key: string; score: number | null; max: number; n_a: boolean }>(
    db,
    `SELECT r.audit_id, m.key, r.score::float8 AS score, r.max::float8 AS max, r.n_a
       FROM metric_result r JOIN metric m ON m.id = r.metric_id WHERE r.audit_id = ANY($1)`,
    ids,
    transaction,
  );
  const checks = await byAuditId<{ audit_id: number; code: string; result: string }>(
    db,
    "SELECT audit_id, check_code AS code, result FROM audit_check WHERE audit_id = ANY($1)",
    ids,
    transaction,
  );
  const flags = await byAuditId<Flag & { audit_id: number }>(
    db,
    "SELECT audit_id, condition_code AS code, source, evidence FROM failure_flag WHERE audit_id = ANY($1) ORDER BY id",
    ids,
    transaction,
  );
  const scorecards = await assignedScorecards(db, transaction);
  return audits.map(({ id, ...a }) => {
    const m = (metrics.get(id) ?? []).map(({ key, score, max, n_a }) => ({ key, score, max, n_a }));
    const scorecard = scorecards.get(rollupAgent(a.agent_code, a.agent_id));
    const auditFlags = (flags.get(id) ?? []).map(({ code, source, evidence }) => ({ code, source, evidence }));
    return {
      ...a,
      call_created_at: new Date(a.call_created_at),
      failure_codes: a.failure_codes ?? [],
      checks: (checks.get(id) ?? []).map(({ code, result }) => ({ code, result })),
      metrics: m,
      rescored: scorecard && m.length ? rescoreForRollup({ metrics: m }, auditFlags, scorecard) : null,
    };
  });
}

async function insertAuditRollups(db: Sequelize, rows: AuditRollup[], transaction: Transaction) {
  for (const r of rows) {
    await db.query(
      `INSERT INTO daily_rollup (day, agent_code, scorecard_id, scorecard_version, audited, passed, failed, needs_review,
         system_pass, system_fail, system_na, business_achieved, business_partial, business_not_achieved, business_na,
         score_sum, scored, buckets, histogram, metric_averages, failure_codes,
         direction, goal_version, sampled, system_checks, business_reasons, rs_passed, rs_failed, rs_score_sum, rs_scored, rs_histogram,
         refreshed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, $19, $20::jsonb, $21::jsonb,
         $22, $23, $24, $25::jsonb, $26::jsonb, $27, $28, $29, $30, $31, now())`,
      {
        bind: [
          r.day,
          r.agent_code,
          r.scorecard_id,
          r.scorecard_version,
          r.audited,
          r.passed,
          r.failed,
          r.needs_review,
          r.system_pass,
          r.system_fail,
          r.system_na,
          r.business_achieved,
          r.business_partial,
          r.business_not_achieved,
          r.business_na,
          r.score_sum,
          r.scored,
          JSON.stringify(r.buckets),
          r.histogram,
          JSON.stringify(r.metric_averages),
          JSON.stringify(r.failure_codes),
          r.direction,
          r.goal_version,
          r.sampled,
          JSON.stringify(r.system_checks),
          JSON.stringify(r.business_reasons),
          r.rs_passed,
          r.rs_failed,
          r.rs_score_sum,
          r.rs_scored,
          r.rs_histogram,
        ],
        transaction,
      },
    );
  }
}

/** Recomputes `daily_rollup` for these IST days (`YYYY-MM-DD`). Returns the rows written. */
export async function refreshAuditDays(db: Sequelize, days: string[]): Promise<AuditRollup[]> {
  const list = uniqueDays(days);
  if (!list.length) return [];
  return db.transaction(async (transaction) => {
    await db.query(LOCK, { transaction });
    const rows = buildAuditRollups(await loadAudits(db, list, transaction));
    await db.query("DELETE FROM daily_rollup WHERE day = ANY($1::date[])", { bind: [list], transaction });
    await insertAuditRollups(db, rows, transaction);
    return rows;
  });
}

/**
 * The refresh `runAuditV2` and the re-score route run after their write: the call's IST day. A failed refresh is
 * logged, never thrown, so it can't fail the audit; the nightly rebuild repairs it.
 */
export async function refreshAuditDaysQuietly(db: Sequelize, callCreatedAt: Date | string | null | undefined, why: string) {
  if (!callCreatedAt) return;
  try {
    await refreshAuditDays(db, [istDay(new Date(callCreatedAt))]);
  } catch (e) {
    console.error(`[rollup] refresh after ${why} failed: ${(e as Error).message}. The nightly rebuild will repair it.`);
  }
}

/** Source call counts by IST day, agent and status (`sourceCallCountsByDay`), for one UTC range or everything. */
export type CallCountSource = (range?: { from: Date; to: Date }) => Promise<CallStatusGroup[]>;

async function insertCallRollups(db: Sequelize, rows: CallRollup[], transaction: Transaction) {
  for (const r of rows) {
    await db.query(
      `INSERT INTO daily_call_rollup (day, agent_code, direction, total, connected, not_connected, refreshed_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())`,
      { bind: [r.day, r.agent_code, r.direction, r.total, r.connected, r.not_connected], transaction },
    );
  }
}

/** Recomputes `daily_call_rollup` for these IST days from the source. Returns the rows written. */
export async function refreshCallDays(db: Sequelize, source: CallCountSource, days: string[]): Promise<CallRollup[]> {
  const list = uniqueDays(days);
  if (!list.length) return [];
  const groups = (await Promise.all(list.map((d) => source(istDayRange(d))))).flat();
  const rows = buildCallRollups(groups.filter((g) => list.includes(g.day)));
  return db.transaction(async (transaction) => {
    await db.query(LOCK, { transaction });
    await db.query("DELETE FROM daily_call_rollup WHERE day = ANY($1::date[])", { bind: [list], transaction });
    await insertCallRollups(db, rows, transaction);
    return rows;
  });
}

/**
 * The nightly full rebuild: both tables replaced from every current audit and, when `source` is given, every source
 * call. Without a source (SOURCE_DB_* unset) the call table is left as it is.
 */
export async function rebuildAllRollups(db: Sequelize, source: CallCountSource | null) {
  const groups = source ? await source() : null;
  return db.transaction(async (transaction) => {
    await db.query(LOCK, { transaction });
    const audits = buildAuditRollups(await loadAudits(db, null, transaction));
    await db.query("DELETE FROM daily_rollup", { transaction });
    await insertAuditRollups(db, audits, transaction);
    let calls: CallRollup[] | null = null;
    if (groups) {
      calls = buildCallRollups(groups);
      await db.query("DELETE FROM daily_call_rollup", { transaction });
      await insertCallRollups(db, calls, transaction);
    }
    return { audits, calls };
  });
}


/**
 * After a scorecard is published or assigned: the re-scored numbers use each agent's assigned scorecard, so every day
 * of `daily_rollup` is rebuilt (call counts are untouched). Logged, never thrown.
 */
export async function rebuildAuditRollupsQuietly(db: Sequelize, why: string) {
  try {
    await rebuildAllRollups(db, null);
  } catch (e) {
    console.error(`[rollup] rebuild after ${why} failed: ${(e as Error).message}. The nightly rebuild will repair it.`);
  }
}

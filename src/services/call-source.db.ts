import { env } from "@/env";
import { Pool } from "pg";

/**
 * Read-only access to integration-service's `voice_call_logs`, for auditing calls straight from
 * the source table: backfills (`replay --db`) and the sync job. Only ever runs SELECTs.
 */
let pool: Pool | null = null;
function getPool(): Pool {
  if (!env.SOURCE_DB_HOSTNAME || !env.SOURCE_DB_USERNAME) {
    throw new Error("SOURCE_DB_* is not configured (read access to voice_call_logs)");
  }
  return (pool ??= new Pool({
    host: env.SOURCE_DB_HOSTNAME,
    port: env.SOURCE_DB_PORT,
    user: env.SOURCE_DB_USERNAME,
    password: env.SOURCE_DB_PASSWORD,
    database: env.SOURCE_DB_NAME,
    ssl: env.SOURCE_DB_SSL ? { rejectUnauthorized: false } : undefined,
    max: 3,
  }));
}

export const sourceDbConfigured = () => Boolean(env.SOURCE_DB_HOSTNAME && env.SOURCE_DB_USERNAME);

// Everything the auditor reads (v2 also picked_at and system_ref_id); phone numbers, tokens and join urls are deliberately
// not selected.
const COLUMNS = `id, business_id, agent_id, status, call_type, provider, voice_provider, is_playground, duration,
  ended_reason, recording_url, summary, transcriptions, outcome, meta_data, data, created_at, ends_at, picked_at, system_ref_id`;

export type SourceQuery = {
  agent_ids?: number[];
  business_id?: number;
  call_ids?: number[];
  from?: string;
  to?: string;
  /** Only calls that ended at or after this time (sync job). */
  ended_after?: Date;
  include_playground?: boolean;
  limit?: number;
  order?: "newest" | "oldest";
};

/** Completed calls with a transcript, matching the filters. */
export async function fetchSourceCalls(q: SourceQuery): Promise<any[]> {
  const where = [`status = 'completed'`, `json_array_length(coalesce(transcriptions, '[]'::json)) > 0`];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace("?", `$${params.length}`));
  };
  if (q.agent_ids?.length) add(`agent_id = ANY(?)`, q.agent_ids);
  if (q.business_id) add(`business_id = ?`, q.business_id);
  if (q.call_ids?.length) add(`id = ANY(?)`, q.call_ids);
  if (q.from) add(`created_at >= ?`, new Date(q.from));
  if (q.to) add(`created_at < ?`, new Date(q.to));
  if (q.ended_after) add(`coalesce(ends_at, updated_at) >= ?`, q.ended_after);
  if (!q.include_playground) where.push(`coalesce(is_playground, false) = false`);
  params.push(q.limit ?? 50);

  const { rows } = await getPool().query(
    `SELECT ${COLUMNS} FROM voice_call_logs WHERE ${where.join(" AND ")}
     ORDER BY created_at ${q.order === "oldest" ? "ASC" : "DESC"} LIMIT $${params.length}`,
    params,
  );
  return rows;
}

export type CallListQuery = {
  agent_ids?: number[];
  business_id?: number;
  status?: string;
  call_type?: string;
  from?: string;
  to?: string;
  /** Restrict to these ids (e.g. calls matching an audit filter). */
  only_ids?: number[];
  /** Leave these ids out (e.g. "not audited yet"). */
  exclude_ids?: number[];
  search?: string;
  order?: "newest" | "oldest";
  limit: number;
  offset: number;
};

// List view: no transcript bodies, just their length.
const LIST_COLUMNS = `id, business_id, agent_id, status, call_type, provider, voice_provider, is_playground, duration,
  ended_reason, created_at, ends_at, picked_at, retries, data->>'agent_code' AS agent_code,
  data->'config'->>'prompt_code' AS prompt_code, json_array_length(coalesce(transcriptions, '[]'::json)) AS turns,
  (recording_url IS NOT NULL) AS has_recording, (summary IS NOT NULL AND summary <> '') AS has_summary,
  coalesce(data->'metadata'->>'name', meta_data->>'name') AS contact_name`;

/** Every call in voice_call_logs (any status), newest first, with a total for pagination. */
export async function listSourceCalls(q: CallListQuery): Promise<{ rows: any[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replaceAll("?", `$${params.length}`));
  };
  if (q.agent_ids?.length) add(`agent_id = ANY(?)`, q.agent_ids);
  if (q.business_id) add(`business_id = ?`, q.business_id);
  if (q.status) add(`status = ?`, q.status);
  if (q.call_type) add(`call_type = ?`, q.call_type);
  if (q.from) add(`created_at >= ?`, new Date(q.from));
  if (q.to) add(`created_at < ?`, new Date(q.to));
  if (q.only_ids) add(`id = ANY(?)`, q.only_ids);
  if (q.exclude_ids?.length) add(`NOT (id = ANY(?))`, q.exclude_ids);
  if (q.search) {
    const asId = Number(q.search);
    if (Number.isInteger(asId)) add(`(id = ? OR system_ref_id = ?::text)`, asId);
    else add(`(coalesce(data->'metadata'->>'name', meta_data->>'name') ILIKE ? OR summary ILIKE ?)`, `%${q.search}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const pool = getPool();
  const [{ rows }, count] = await Promise.all([
    pool.query(
      `SELECT ${LIST_COLUMNS} FROM voice_call_logs ${whereSql}
       ORDER BY created_at ${q.order === "oldest" ? "ASC" : "DESC"}, id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, q.limit, q.offset],
    ),
    pool.query(`SELECT count(*)::int AS n FROM voice_call_logs ${whereSql}`, params),
  ]);
  return { rows, total: count.rows[0].n };
}

/**
 * One call with everything the dashboard shows. The join token and join url are never selected:
 * they are live credentials for the call session.
 */
export async function getSourceCall(id: number): Promise<any | null> {
  const { rows } = await getPool().query(
    `SELECT id, business_id, agent_id, status, call_type, provider, voice_provider, provider_call_id, is_playground,
       phone_number, source_phone_number, duration, ended_reason, error_detail, recording_url, summary, transcriptions,
       outcome, meta_data, tags, system_ref_id, conversation_ref, retries, scheduled_at, initiated_at, picked_at, ends_at,
       created_at, updated_at, data
     FROM voice_call_logs WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/** Call counts by status, for the headline numbers. */
export async function sourceCallCounts(agent_ids?: number[]): Promise<Record<string, number>> {
  const { rows } = await getPool().query(
    `SELECT status, count(*)::int AS n FROM voice_call_logs ${agent_ids?.length ? "WHERE agent_id = ANY($1)" : ""} GROUP BY status`,
    agent_ids?.length ? [agent_ids] : [],
  );
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

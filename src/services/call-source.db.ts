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

// Everything the auditor reads; phone numbers, tokens and join urls are deliberately not selected.
const COLUMNS = `id, business_id, agent_id, status, call_type, provider, voice_provider, is_playground, duration,
  ended_reason, recording_url, summary, transcriptions, outcome, meta_data, data, created_at, ends_at`;

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

import { Pool, type PoolConfig } from "pg";

/** What a v2 reader needs from another service's database: SELECTs and nothing else. */
export type ReadOnlyDb = { query<T = any>(sql: string, params?: unknown[]): Promise<T[]> };

export type ReadOnlyDbConfig = {
  host?: string;
  port: number;
  user?: string;
  password: string;
  database?: string;
  ssl: boolean;
};

const SELECT_ONLY = /^\s*SELECT\s/i;

/** Throws unless `sql` is a single SELECT; checked before any query reaches another service's DB. */
export function assertSelect(sql: string): void {
  if (!SELECT_ONLY.test(sql) || sql.replace(/;\s*$/, "").includes(";")) {
    throw new Error(`read-only db: only single SELECT statements are allowed`);
  }
}

/**
 * A small read-only pool to another service's database, built like `call-source.db.ts`. Null when the login isn't
 * configured, so the reader degrades instead of failing the audit. The session is also opened read-only, so even a
 * statement that slipped past `assertSelect` couldn't write.
 */
export function readOnlyDb(
  cfg: ReadOnlyDbConfig,
  createPool: (config: PoolConfig) => Pick<Pool, "query"> = (config) => new Pool(config),
): ReadOnlyDb | null {
  if (!cfg.host || !cfg.user || !cfg.database) return null;
  let pool: Pick<Pool, "query"> | null = null;
  return {
    async query(sql, params = []) {
      assertSelect(sql);
      pool ??= createPool({
        host: cfg.host,
        port: cfg.port,
        user: cfg.user,
        password: cfg.password,
        database: cfg.database,
        ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
        options: "-c default_transaction_read_only=on",
        statement_timeout: 10_000,
        max: 2,
      });
      const { rows } = await pool.query(sql, params);
      return rows;
    },
  };
}

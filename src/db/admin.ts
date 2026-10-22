import { env } from "@/env";
import { Client } from "pg";

const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** Runs `fn` with a client on the server's `postgres` database (creating or dropping a database can't run inside it). */
async function withAdmin<T>(fn: (admin: Client) => Promise<T>): Promise<T> {
  const admin = new Client({
    host: env.DB_HOSTNAME,
    port: env.DB_PORT,
    user: env.DB_USERNAME,
    password: env.DB_PASSWORD,
    database: "postgres",
    ssl: env.DB_SSL ? { rejectUnauthorized: false } : undefined,
  });
  await admin.connect();
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

/** Creates the database if missing. Returns true when it was created. */
export const ensureDatabase = (name: string) =>
  withAdmin(async (admin) => {
    const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (exists.rowCount !== 0) return false;
    await admin.query(`CREATE DATABASE ${quoted(name)}`);
    return true;
  });

export const dropDatabase = (name: string) => withAdmin((admin) => admin.query(`DROP DATABASE IF EXISTS ${quoted(name)} WITH (FORCE)`));

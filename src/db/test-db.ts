import { env } from "@/env";
import { Sequelize } from "sequelize";
import { dropDatabase, ensureDatabase } from "./admin";

/** Prefix of every throwaway test database; tests refuse to write to a database without it. */
export const TEST_DB_PREFIX = "brahmaverse_audit_test_";

/** DB tests run only under `bun run test:db`, so `bun run test` needs no database. */
export const dbTestsEnabled = Boolean(process.env.AUDIT_TEST_DB);

/** Creates an empty database on the DB_* server and connects to it; `drop()` closes and removes it. */
export async function createTestDb() {
  const name = `${TEST_DB_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await ensureDatabase(name);
  const sequelize = new Sequelize(name, env.DB_USERNAME, env.DB_PASSWORD, {
    dialect: "postgres",
    host: env.DB_HOSTNAME,
    port: env.DB_PORT,
    logging: false,
    dialectOptions: env.DB_SSL ? { ssl: { require: true, rejectUnauthorized: false } } : {},
  });
  return {
    name,
    sequelize,
    drop: async () => {
      await sequelize.close();
      await dropDatabase(name);
    },
  };
}

/**
 * Runs `fn` against a fresh empty database and always drops it afterwards. (Bun 1.2's test runner exits
 * silently when a second describe's beforeAll/afterAll creates and drops a database, so each test owns its own.)
 */
export async function withTestDb<T>(fn: (sequelize: Sequelize, name: string) => Promise<T>): Promise<T> {
  const db = await createTestDb();
  try {
    return await fn(db.sequelize, db.name);
  } finally {
    await db.drop();
  }
}

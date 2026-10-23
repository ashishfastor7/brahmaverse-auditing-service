import { env } from "@/env";
import { readOnlyDb, type ReadOnlyDb } from "./readonly-db";

/** ai-service's database (`prompts`, `knowledgebase_documents`) over `AI_DB_*`; null when not configured. */
const db = readOnlyDb({
  host: env.AI_DB_HOSTNAME,
  port: env.AI_DB_PORT,
  user: env.AI_DB_USERNAME,
  password: env.AI_DB_PASSWORD,
  database: env.AI_DB_NAME,
  ssl: env.AI_DB_SSL,
});

export const aiDb = (): ReadOnlyDb | null => db;

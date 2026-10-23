import { env } from "@/env";
import { readOnlyDb, type ReadOnlyDb } from "./readonly-db";

/** vajra-app-service's database (`conversations`, `workflow_executions`, `workflow_versions`) over `VAJRA_DB_*`. */
const db = readOnlyDb({
  host: env.VAJRA_DB_HOSTNAME,
  port: env.VAJRA_DB_PORT,
  user: env.VAJRA_DB_USERNAME,
  password: env.VAJRA_DB_PASSWORD,
  database: env.VAJRA_DB_NAME,
  ssl: env.VAJRA_DB_SSL,
});

export const vajraDb = (): ReadOnlyDb | null => db;

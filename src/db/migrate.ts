import { env } from "@/env";
import { Client } from "pg";
import { sequelize } from "./index";

/** Creates the database if missing, then syncs the tables (same `sync({ alter })` approach as the other services). */
async function migrate() {
  const admin = new Client({
    host: env.DB_HOSTNAME,
    port: env.DB_PORT,
    user: env.DB_USERNAME,
    password: env.DB_PASSWORD,
    database: "postgres",
    ssl: env.DB_SSL ? { rejectUnauthorized: false } : undefined,
  });
  await admin.connect();
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [env.DB_NAME]);
  if (exists.rowCount === 0) {
    await admin.query(`CREATE DATABASE "${env.DB_NAME.replaceAll('"', '""')}"`);
    console.log(`created database ${env.DB_NAME}`);
  }
  await admin.end();

  await sequelize.sync({ alter: true });
  console.log("tables in sync");
  await sequelize.close();
}

migrate().catch((e) => {
  console.error("migration failed:", e.message);
  process.exit(1);
});

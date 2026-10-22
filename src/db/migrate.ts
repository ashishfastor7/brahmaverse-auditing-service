import { env } from "@/env";
import { ensureDatabase } from "./admin";
import { sequelize } from "./connection";
import { migrateCommand } from "./migrator";

/**
 * `bun run migrate`: creates the database if missing, then applies pending migrations.
 * `bun run migrate:down [--drop-table]`: reverts the last applied migration. Reverting the baseline drops
 * audit_results, so it needs `--drop-table`.
 */
async function main() {
  const down = process.argv.includes("down");
  if (!down && (await ensureDatabase(env.DB_NAME))) console.log(`created database ${env.DB_NAME}`);
  console.log(await migrateCommand(sequelize, { down, dropTable: process.argv.includes("--drop-table") }));
}

main()
  .then(() => sequelize.close())
  .catch(async (e) => {
    console.error("migration failed:", e.message);
    await sequelize.close();
    process.exit(1);
  });

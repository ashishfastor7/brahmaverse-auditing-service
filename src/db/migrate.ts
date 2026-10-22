import { env } from "@/env";
import { ensureDatabase } from "./admin";
import { sequelize } from "./connection";
import { BASELINE, createMigrator } from "./migrator";

/**
 * `bun run migrate`: creates the database if missing, then applies pending migrations.
 * `bun run migrate:down [--drop-table]`: reverts the last applied migration. Reverting the baseline drops
 * audit_results, so it needs `--drop-table`.
 */
async function main() {
  const down = process.argv.includes("down");
  if (!down && (await ensureDatabase(env.DB_NAME))) console.log(`created database ${env.DB_NAME}`);

  const migrator = createMigrator(sequelize, { quiet: true });
  if (down) {
    const executed = await migrator.executed();
    const last = executed.at(-1)?.name;
    if (!last) return console.log("nothing to revert");
    if (last === BASELINE && !process.argv.includes("--drop-table")) {
      throw new Error(`reverting ${BASELINE} drops audit_results and every stored audit; pass --drop-table to do it`);
    }
    await migrator.down();
    console.log(`reverted ${last}`);
  } else {
    const applied = await migrator.up();
    console.log(applied.length ? `applied ${applied.map((m) => m.name).join(", ")}` : "up to date");
  }
}

main()
  .then(() => sequelize.close())
  .catch(async (e) => {
    console.error("migration failed:", e.message);
    await sequelize.close();
    process.exit(1);
  });

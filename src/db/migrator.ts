import { QueryTypes, type Sequelize } from "sequelize";
import { type MigrationFn, SequelizeStorage, Umzug } from "umzug";
import { migrations } from "./migrations";

export type Migration = MigrationFn<Sequelize>;

/** The migration that creates audit_results; reverting it drops every stored audit. */
export const BASELINE = "0001-baseline";

/**
 * Umzug over the numbered files in `migrations/`, recording applied ones in `SequelizeMeta`.
 * Takes the connection as an argument (instead of importing `@/db`) so tests can point it at a throwaway database.
 */
export const createMigrator = (sequelize: Sequelize, opts: { quiet?: boolean } = {}) =>
  new Umzug({
    migrations,
    context: sequelize,
    storage: new SequelizeStorage({ sequelize }),
    logger: opts.quiet ? undefined : console,
  });

/**
 * What `bun run migrate` / `bun run migrate:down` do, returning the line to print. Down reverts only the
 * last applied migration and refuses the baseline (it drops every stored audit) unless `dropTable`.
 */
export async function migrateCommand(sequelize: Sequelize, opts: { down?: boolean; dropTable?: boolean } = {}): Promise<string> {
  const migrator = createMigrator(sequelize, { quiet: true });
  if (!opts.down) {
    const applied = await migrator.up();
    return applied.length ? `applied ${applied.map((m) => m.name).join(", ")}` : "up to date";
  }
  const last = (await migrator.executed()).at(-1)?.name;
  if (!last) return "nothing to revert";
  if (last === BASELINE && !opts.dropTable) {
    throw new Error(`reverting ${BASELINE} drops audit_results and every stored audit; pass --drop-table to do it`);
  }
  await migrator.down();
  return `reverted ${last}`;
}

/**
 * Names of migrations not yet applied, read without writing anything (Umzug's own `pending()` creates
 * SequelizeMeta when it is missing). The API checks this on startup.
 */
export async function pendingMigrations(sequelize: Sequelize): Promise<string[]> {
  const [{ exists }] = await sequelize.query<{ exists: boolean }>(`SELECT to_regclass('public."SequelizeMeta"') IS NOT NULL AS exists`, {
    type: QueryTypes.SELECT,
  });
  const applied = exists
    ? new Set((await sequelize.query<{ name: string }>(`SELECT name FROM "SequelizeMeta"`, { type: QueryTypes.SELECT })).map((r) => r.name))
    : new Set<string>();
  return migrations.map((m) => m.name).filter((name) => !applied.has(name));
}

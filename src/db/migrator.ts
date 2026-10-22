import type { Sequelize } from "sequelize";
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

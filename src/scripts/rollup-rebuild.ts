/**
 * P2-6: rebuild the daily roll-ups by hand (backfills, after a fix). Aggregation only: never runs an audit.
 *
 *   bun run rollup:rebuild                                    # everything, as the nightly job does
 *   bun run rollup:rebuild --from 2026-11-01 --to 2026-11-06  # only these IST days (both included)
 *
 * Call counts need SOURCE_DB_*; without it only daily_rollup is rebuilt.
 */
import { rebuildRollupsNow } from "@/background/rollup.job";
import { sequelize } from "@/db";
import { daysBetween } from "@/audit/v2/rollup";
import { refreshAuditDays, refreshCallDays } from "@/db/rollup";
import { sourceCallCountsByDay, sourceDbConfigured } from "@/services/call-source.db";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({ options: { from: { type: "string" }, to: { type: "string" } } });

try {
  if (!args.from && !args.to) await rebuildRollupsNow();
  else {
    if (!args.from || !args.to) throw new Error("give both --from and --to (YYYY-MM-DD, IST days), or neither");
    const days = daysBetween(args.from, args.to);
    if (!days.length) throw new Error("--from is after --to");
    const audits = await refreshAuditDays(sequelize, days);
    const calls = sourceDbConfigured() ? await refreshCallDays(sequelize, sourceCallCountsByDay, days) : null;
    console.log(
      `[rollup] ${days.length} day(s): ${audits.length} audit row(s)` +
        (calls ? `, ${calls.length} call row(s)` : "; call counts skipped (SOURCE_DB_* not set)"),
    );
  }
} catch (e) {
  console.error(`[rollup] ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await sequelize.close();
}

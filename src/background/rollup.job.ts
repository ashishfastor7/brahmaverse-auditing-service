import { msUntilIstHour } from "@/audit/v2/rollup";
import { sequelize } from "@/db";
import { rebuildAllRollups } from "@/db/rollup";
import { env } from "@/env";
import { sourceCallCountsByDay, sourceDbConfigured } from "@/services/call-source.db";

/**
 * P2-6 nightly roll-up rebuild: once a day at AUDIT_ROLLUP_HOUR_IST, `daily_rollup` and `daily_call_rollup` are
 * recomputed from every current audit and every source call. Aggregation only: it never runs or schedules an audit.
 */
export async function rebuildRollupsNow() {
  const started = Date.now();
  const source = sourceDbConfigured() ? sourceCallCountsByDay : null;
  const { audits, calls } = await rebuildAllRollups(sequelize, source);
  console.log(
    `[rollup] rebuilt ${audits.length} audit row(s)` +
      (calls ? `, ${calls.length} call row(s)` : "; call counts skipped (SOURCE_DB_* not set)") +
      ` in ${Date.now() - started} ms`,
  );
}

export function startRollupJob() {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await rebuildRollupsNow();
    } catch (e) {
      console.error(`[rollup] nightly rebuild failed: ${(e as Error).message}`);
    } finally {
      running = false;
    }
  };
  const schedule = () => {
    setTimeout(async () => {
      await run();
      schedule();
    }, msUntilIstHour(new Date(), env.AUDIT_ROLLUP_HOUR_IST));
  };
  schedule();
  console.log(`[rollup] nightly rebuild at ${String(env.AUDIT_ROLLUP_HOUR_IST).padStart(2, "0")}:00 IST`);
}

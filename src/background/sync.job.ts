import { normalizeCall } from "@/audit/normalize";
import { runAudit } from "@/audit/run-audit";
import { tables } from "@/db";
import { env } from "@/env";
import { fetchSourceCalls } from "@/services/call-source.db";
import { Op } from "sequelize";

/**
 * Polls `voice_call_logs` (read-only) for calls that ended recently and audits the ones not yet
 * audited. This is the integration path that needs no change to integration-service; the
 * `voicecall.ended` event, once that patch is applied, does the same thing instantly.
 *
 * Bounded on purpose — every audit is an LLM call: only the configured agents, only calls that
 * ended within the lookback window, at most AUDIT_SYNC_MAX_PER_RUN per run.
 */
async function syncOnce() {
  const candidates = await fetchSourceCalls({
    agent_ids: env.AUDIT_SYNC_AGENT_IDS.length ? env.AUDIT_SYNC_AGENT_IDS : undefined,
    ended_after: new Date(Date.now() - env.AUDIT_SYNC_LOOKBACK_HOURS * 3_600_000),
    include_playground: env.AUDIT_INCLUDE_PLAYGROUND,
    limit: 500,
    order: "oldest",
  });
  if (candidates.length === 0) return;

  const seen = await tables.AuditResult.findAll({
    attributes: ["call_id"],
    where: { source: "voice_call_logs", call_id: { [Op.in]: candidates.map((c) => c.id) }, status: { [Op.ne]: "failed" } },
    raw: true,
  });
  const done = new Set(seen.map((r) => r.call_id));
  const todo = candidates.filter((c) => !done.has(c.id)).slice(0, env.AUDIT_SYNC_MAX_PER_RUN);
  if (todo.length === 0) return;

  console.log(`[sync] auditing ${todo.length} new call(s)`);
  for (const raw of todo) {
    await runAudit(normalizeCall(raw)).catch(() => {
      /* recorded as failed by runAudit; retried on a later run */
    });
  }
}

export function startSyncJob() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await syncOnce();
    } catch (e) {
      console.error(`[sync] ${(e as Error).message}`);
    } finally {
      running = false;
    }
  };
  setInterval(tick, env.AUDIT_SYNC_INTERVAL_MINUTES * 60_000);
  void tick();
  console.log(
    `[sync] polling voice_call_logs every ${env.AUDIT_SYNC_INTERVAL_MINUTES} min ` +
      `(agents ${env.AUDIT_SYNC_AGENT_IDS.join(",") || "all"}, last ${env.AUDIT_SYNC_LOOKBACK_HOURS} h, max ${env.AUDIT_SYNC_MAX_PER_RUN}/run)`,
  );
}

/**
 * Audits calls that already happened, without the voicecall.ended event.
 *
 *   bun run replay --file calls.json [--agent-code hrms] [--limit 20] [--force]
 *     calls.json: a JSON array of voice_call_logs rows (e.g. exported from DataGrip).
 *
 *   bun run replay --rpc --business-id 10 [--agent-id 3] --agent-code hrms [--from 2026-09-01 --to 2026-10-01] [--limit 20] [--force]
 *     pulls calls through integration-service's existing query.voicecall.list RPC. That listing has
 *     no agent_code, so pass it; it also has no prompt_code, so these are graded without the agent's prompt.
 */
import { normalizeCall } from "@/audit/normalize";
import { runAudit } from "@/audit/run-audit";
import { sequelize } from "@/db";
import { listCalls } from "@/services/call-source.service";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    file: { type: "string" },
    rpc: { type: "boolean", default: false },
    "business-id": { type: "string" },
    "agent-id": { type: "string" },
    "agent-code": { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    limit: { type: "string" },
    force: { type: "boolean", default: false },
  },
});

async function loadCalls(): Promise<any[]> {
  if (args.file) {
    const parsed = JSON.parse(readFileSync(args.file, "utf8"));
    return Array.isArray(parsed) ? parsed : (parsed.data ?? parsed.rows ?? [parsed]);
  }
  if (args.rpc) {
    if (!args["business-id"]) throw new Error("--rpc needs --business-id");
    return listCalls({
      business_id: Number(args["business-id"]),
      agent_id: args["agent-id"] ? Number(args["agent-id"]) : undefined,
      date_range: args.from && args.to ? { from: args.from, to: args.to } : undefined,
    });
  }
  throw new Error("pass --file <calls.json> or --rpc --business-id <id>");
}

const overrides = {
  ...(args["agent-code"] ? { agent_code: args["agent-code"] } : {}),
  ...(args["business-id"] ? { business_id: Number(args["business-id"]) } : {}),
  ...(args["agent-id"] ? { agent_id: Number(args["agent-id"]) } : {}),
};

const calls = (await loadCalls()).slice(0, args.limit ? Number(args.limit) : undefined);
console.log(`auditing ${calls.length} call(s)`);

const tally = { completed: 0, skipped: 0, failed: 0 };
for (const raw of calls) {
  const input = normalizeCall(raw, overrides);
  try {
    const row = await runAudit(input, { force: args.force });
    tally[row.status === "completed" ? "completed" : row.status === "skipped" ? "skipped" : "failed"]++;
    const detail =
      row.status === "completed"
        ? `score=${row.overall_score} ${row.success_result} goal=${row.goal_result}`
        : (row.skip_reason ?? row.error ?? row.status);
    console.log(`call ${input.call_id}: ${row.status} ${detail}`);
  } catch (e) {
    tally.failed++;
    console.log(`call ${input.call_id}: failed ${(e as Error).message}`);
  }
}
console.log(tally);
await sequelize.close();
process.exit(0);

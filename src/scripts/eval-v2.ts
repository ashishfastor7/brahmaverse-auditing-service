/**
 * P1-19: runs the current v2 judge on the planted cases and the golden-set calls and reports agreement with the
 * reviewers. Manual only. Judge answers are cached per call and judge prompt version in eval-output/judge-cache/, so an
 * unchanged call is never billed twice. The report goes to docs/evals/<date>-<judge prompt version>.md (ids and numbers
 * only); judge reasons and reviewer notes for the biggest disagreements are printed here, never saved.
 *
 *   bun run eval:v2 [--only-planted] [--case wrong-language --case …] [--concurrency 4]
 *   bun run eval:v2 --compare <old judge prompt version | path to a report>
 *   bun run eval:v2 --draft --compare <version>   (before publishing: grade with the agents' scorecard / goal drafts;
 *     saved as <date>-<version>-draft.md, so the published baseline stays the one --compare reads)
 *
 * Exits 1 when a planted case misses, or with --compare when a planted case broke or any agreement number dropped.
 * Needs the audit DB (published config, reviews), SOURCE_DB_* for golden calls, OPENAI_API_KEY and AUDIT_V2_JUDGE_MODEL.
 */
import { type CacheStats, cachedJudge } from "@/audit/v2/eval/judge-cache";
import { compareRuns, type Comparison, EVALS_DIR, findReport, readReport, renderReport, reportPath } from "@/audit/v2/eval/report";
import { type AgentConfig, evaluate, exitCode, goldenContexts, plantedContext } from "@/audit/v2/eval/run";
import { JUDGE_PROMPT_VERSION } from "@/audit/v2/judge/prompt";
import { loadAuditContextV2, v2Judge } from "@/audit/v2/run-audit";
import { sequelize } from "@/db";
import { loadActiveConfig, loadConditionDefinitions, loadDraftConfig } from "@/db/config-store";
import { loadGoldenSet } from "@/db/golden-set";
import { env } from "@/env";
import { fetchSourceCalls } from "@/services/call-source.db";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { cases, plantedAgent } from "../../fixtures/planted/cases";

const { values: args } = parseArgs({
  options: {
    compare: { type: "string" },
    "only-planted": { type: "boolean", default: false },
    draft: { type: "boolean", default: false },
    case: { type: "string", multiple: true },
    concurrency: { type: "string", default: "4" },
  },
});

// Read the old report first: today's run may overwrite a same-day report of the same version.
const old = args.compare ? { path: findReport(args.compare) } : null;
const oldData = old ? readReport(old.path) : null;

const configs = new Map<string, AgentConfig>();
async function agentConfig(agentCode: string): Promise<AgentConfig> {
  const cached = configs.get(agentCode);
  if (cached) return cached;
  const config = await (args.draft ? loadDraftConfig : loadActiveConfig)(sequelize, agentCode, null);
  if (config.reason !== null) throw new Error(`no published v2 config for ${agentCode}: ${config.reason}`);
  const enabled = config.scorecard.conditions.filter((c) => c.enabled).map((c) => c.condition_code);
  const loaded = { scorecard: config.scorecard, goal: config.goal, definitions: await loadConditionDefinitions(sequelize, enabled) };
  configs.set(agentCode, loaded);
  return loaded;
}

const planted = [];
for (const c of cases.filter((x) => !args.case || args.case.includes(x.name))) {
  planted.push({ case: c, context: plantedContext(c, await agentConfig(plantedAgent(c).agent_code)) });
}

const rows = args["only-planted"] ? [] : await loadGoldenSet(sequelize);
const sources = rows.length
  ? await fetchSourceCalls({ call_ids: rows.map((r) => r.call_id), include_playground: true, limit: rows.length })
  : [];
const golden = await goldenContexts(rows, sources, (raw) => loadAuditContextV2(sequelize, raw, { draft: args.draft }));

const { judge, model } = v2Judge();
const stats: CacheStats = { hits: 0, misses: 0 };
const cacheDir = join("eval-output/judge-cache", JUDGE_PROMPT_VERSION);
const date = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
console.log(`judge ${model}, prompt ${JUDGE_PROMPT_VERSION}: ${planted.length} planted case(s), ${golden.length} golden call(s)\n`);

const run = await evaluate({
  date,
  promptVersion: JUDGE_PROMPT_VERSION,
  planted,
  golden,
  judgeFor: (key) => cachedJudge(judge, { dir: cacheDir, key, model, stats }),
  reviewThreshold: env.AUDIT_REVIEW_THRESHOLD,
  concurrency: Number(args.concurrency),
});

let comparison: Comparison | undefined;
if (old && oldData) comparison = compareRuns(oldData, run.data, run.pairs, old.path.replaceAll("\\", "/"));

const report = renderReport(run, { cache: stats, comparison, draft: args.draft });
mkdirSync(EVALS_DIR, { recursive: true });
const file = reportPath(date, JUDGE_PROMPT_VERSION, args.draft);
writeFileSync(file, report);

console.log(report.slice(0, report.indexOf("## Data (read by")).trimEnd());
if (run.top.length) {
  console.log("\nBiggest disagreements, with reasons (not saved):");
  for (const d of run.top) {
    console.log(`\ncall ${d.call_id} (review ${d.review_id ?? "-"}, ${d.kind}): ${d.diffs.join("; ")}`);
    for (const r of d.judge_reasons) console.log(`  judge    | ${r}`);
    console.log(`  reviewer | ${d.note ?? "(no note)"}`);
  }
}
console.log(`\nsaved ${file}`);

await sequelize.close();
process.exit(exitCode(run, comparison));

/**
 * Compares judge models on the v2 pipeline (`auditCallV2`): the planted cases (synthetic, each on its agent's scorecard from
 * the audit DB) and, with --call-id, real calls read from voice_call_logs. Each model grades each call --runs times.
 * Manual only: one OpenAI call per audit (two on a retry). Nothing is written to the audit DB; every answer goes to
 * eval-output/bench-v2/.
 *
 *   bun run bench:judge --model gpt-5.5-2026-04-23 --model gpt-5.6-luna [--runs 2] [--call-id 4422,4578] [--effort medium]
 *     [--case good-call --case agent-loop] (only these planted cases)
 */
import type { Judge } from "@/audit/audit-call";
import { createOpenAIJudge } from "@/audit/judge/openai-judge";
import { type AuditResultV2, auditCallV2 } from "@/audit/v2/audit-call";
import { type AgentConfig, plantedContext } from "@/audit/v2/eval/run";
import { type AuditContextV2, loadAuditContextV2 } from "@/audit/v2/run-audit";
import { sequelize } from "@/db";
import { loadActiveConfig, loadConditionDefinitions } from "@/db/config-store";
import { env } from "@/env";
import { fetchSourceCalls } from "@/services/call-source.db";
import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { cases, plantedAgent, plantedMissesV2 } from "../../fixtures/planted/cases";

const { values: args } = parseArgs({
  options: {
    model: { type: "string", multiple: true },
    runs: { type: "string", default: "2" },
    "call-id": { type: "string" },
    effort: { type: "string", default: "medium" },
    concurrency: { type: "string", default: "4" },
    case: { type: "string", multiple: true },
  },
});
const models = args.model ?? [];
if (!models.length) throw new Error("pass at least one --model");
if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
const runs = Number(args.runs);
const effort = (args.effort || undefined) as "minimal" | "low" | "medium" | "high" | undefined;

/** #4422 is the PRD §1 example: the loop fails the system goal, the customer still agreed (playbook step 10). */
const REAL_EXPECT: Record<number, (r: AuditResultV2) => string[]> = {
  4422: (r) => [
    ...(r.system_goal.result === "FAIL" && r.checks.S2.result === "FAIL" ? [] : [`system goal ${r.system_goal.result}/S2 ${r.checks.S2.result} ≠ FAIL`]),
    ...(r.business_goal?.outcome === "ACHIEVED" ? [] : [`goal ${r.business_goal?.outcome} ≠ ACHIEVED`]),
  ],
};

type Item = { name: string; context: AuditContextV2; check: (r: AuditResultV2) => string[] };

async function plantedItems(): Promise<Item[]> {
  const configs = new Map<string, AgentConfig>();
  const items: Item[] = [];
  for (const c of cases.filter((x) => !args.case || args.case.includes(x.name))) {
    const agentCode = plantedAgent(c).agent_code;
    if (!configs.has(agentCode)) {
      const config = await loadActiveConfig(sequelize, agentCode, null);
      if (config.reason !== null) throw new Error(`no ${agentCode} config: ${config.reason}`);
      const enabled = config.scorecard.conditions.filter((x) => x.enabled).map((x) => x.condition_code);
      configs.set(agentCode, { scorecard: config.scorecard, goal: config.goal, definitions: await loadConditionDefinitions(sequelize, enabled) });
    }
    items.push({ name: c.name, check: (r) => plantedMissesV2(c, r), context: plantedContext(c, configs.get(agentCode)!) });
  }
  return items;
}

async function realItems(): Promise<Item[]> {
  const ids = (args["call-id"] ?? "").split(",").map(Number).filter(Number.isFinite);
  if (!ids.length) return [];
  const rows = await fetchSourceCalls({ call_ids: ids, include_playground: true, limit: ids.length });
  const items: Item[] = [];
  for (const raw of rows) {
    const loaded = await loadAuditContextV2(sequelize, raw);
    if (!loaded.context) {
      console.log(`call ${raw.id}: skipped (${loaded.skip})`);
      continue;
    }
    items.push({ name: `call-${raw.id}`, context: loaded.context, check: REAL_EXPECT[Number(raw.id)] ?? (() => []) });
  }
  return items;
}

type Run = {
  model: string;
  item: string;
  run: number;
  ok: boolean;
  misses: string[];
  attempts: number;
  first_valid: boolean;
  needs_review: boolean;
  evidence_validity: number | null;
  ms: number;
  tokens: { input_tokens: number; output_tokens: number };
  result?: AuditResultV2;
  error?: string;
};

async function pool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < tasks.length) {
        const i = next++;
        out[i] = await tasks[i]!();
      }
    }),
  );
  return out;
}

const items = [...(await plantedItems()), ...(await realItems())];
const dir = "eval-output/bench-v2";
mkdirSync(dir, { recursive: true });

const tasks = models.flatMap((model) => {
  const judge: Judge = createOpenAIJudge({ apiKey: env.OPENAI_API_KEY!, model, reasoningEffort: effort, rawOnInvalidJson: true });
  return items.flatMap((item) =>
    Array.from({ length: runs }, (_, k) => async (): Promise<Run> => {
      const started = Date.now();
      const base = { model, item: item.name, run: k + 1 };
      try {
        const { result, usage } = await auditCallV2(item.context.input, item.context.record, {
          ...item.context,
          judge,
          reviewThreshold: env.AUDIT_REVIEW_THRESHOLD,
        });
        const m = item.check(result);
        const run: Run = {
          ...base,
          ok: m.length === 0,
          misses: m,
          attempts: result.judge.attempts.length,
          first_valid: result.judge.attempts[0]!.errors.length === 0,
          needs_review: result.needs_review,
          evidence_validity: result.judge.evidence_validity,
          ms: Date.now() - started,
          tokens: usage,
          result,
        };
        writeFileSync(`${dir}/${model}--${item.name}--${k + 1}.json`, `${JSON.stringify(run, null, 2)}\n`);
        console.log(`${model} ${item.name}#${k + 1}: ${m.length ? `MISS ${m.join("; ")}` : "ok"} (${run.ms} ms)`);
        return run;
      } catch (e) {
        console.log(`${model} ${item.name}#${k + 1}: ERROR ${(e as Error).message}`);
        return { ...base, ok: false, misses: ["error"], attempts: 0, first_valid: false, needs_review: true, evidence_validity: null, ms: Date.now() - started, tokens: { input_tokens: 0, output_tokens: 0 }, error: (e as Error).message };
      }
    }),
  );
});

const results = await pool(tasks, Number(args.concurrency));

/** Same verdict between runs of one call: flags, business outcome, every check, and each metric within 1 point. */
function consistent(a?: AuditResultV2, b?: AuditResultV2): boolean {
  if (!a || !b) return false;
  const flags = (r: AuditResultV2) => r.flags.map((f) => f.code).sort().join(",");
  if (flags(a) !== flags(b) || a.business_goal?.outcome !== b.business_goal?.outcome) return false;
  if ((["S2", "S3", "S4"] as const).some((c) => a.checks[c].result !== b.checks[c].result)) return false;
  return a.metrics.every((m) => {
    const o = b.metrics.find((x) => x.key === m.key);
    return o && m.n_a === o.n_a && Math.abs((m.score ?? 0) - (o.score ?? 0)) <= 1;
  });
}

const summary = models.map((model) => {
  const rs = results.filter((r) => r.model === model);
  const pairs = items.map((i) => rs.filter((r) => r.item === i.name));
  const validity = rs.map((r) => r.evidence_validity).filter((v): v is number => v !== null);
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 100) / 100 : null);
  return {
    model,
    passed: `${rs.filter((r) => r.ok).length}/${rs.length}`,
    first_try_valid: `${rs.filter((r) => r.first_valid).length}/${rs.length}`,
    needs_review: rs.filter((r) => r.needs_review).length,
    errors: rs.filter((r) => r.error).length,
    evidence_validity: avg(validity),
    consistent_calls: runs > 1 ? `${pairs.filter((p) => consistent(p[0]?.result, p[1]?.result)).length}/${items.length}` : "n/a",
    avg_seconds: avg(rs.map((r) => r.ms / 1000)),
    avg_tokens_in: Math.round(avg(rs.map((r) => r.tokens.input_tokens)) ?? 0),
    avg_tokens_out: Math.round(avg(rs.map((r) => r.tokens.output_tokens)) ?? 0),
    misses: rs.filter((r) => !r.ok).map((r) => `${r.item}#${r.run}: ${r.misses.join("; ")}`),
  };
});
writeFileSync(`${dir}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
await sequelize.close();
process.exit(0);

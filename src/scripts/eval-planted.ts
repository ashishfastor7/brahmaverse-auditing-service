/**
 * Runs the real judge over the planted-defect cases and checks each defect is caught.
 * Needs OPENAI_API_KEY; no database or message bus. Exits non-zero on any miss, so it can gate
 * rubric, prompt and model changes. Full results are written to eval-output/.
 *
 *   bun run eval:planted [--only wrong-salary]
 */
import { auditCall } from "@/audit/audit-call";
import { createOpenAIJudge } from "@/audit/judge/openai-judge";
import { normalizeCall } from "@/audit/normalize";
import { hansaRubric } from "@/audit/rubrics/hansa";
import type { AuditResult } from "@/audit/types";
import { env } from "@/env";
import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { agentPrompt, cases, variables, type PlantedCase } from "../../fixtures/planted/cases";

const { values: args } = parseArgs({ options: { only: { type: "string" } } });
if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");

const judge = createOpenAIJudge({ apiKey: env.OPENAI_API_KEY, model: env.AUDIT_JUDGE_MODEL, reasoningEffort: env.AUDIT_JUDGE_REASONING_EFFORT });

function check(c: PlantedCase, r: AuditResult): string[] {
  const misses: string[] = [];
  const e = c.expect;
  const codes = r.call_success.failure_reasons.map((f) => f.code);
  if (r.call_success.result !== e.success) misses.push(`success ${r.call_success.result} ≠ ${e.success} (${codes.join(",") || "no failures"})`);
  for (const code of e.failure_codes ?? []) if (!codes.includes(code)) misses.push(`missing failure ${code}`);
  if (e.goal && r.call_goal.result !== e.goal) misses.push(`goal ${r.call_goal.result} ≠ ${e.goal}`);
  if (e.goal_reason_code && r.call_goal.reason_code !== e.goal_reason_code) misses.push(`goal reason ${r.call_goal.reason_code} ≠ ${e.goal_reason_code}`);
  if (e.min_score !== undefined && (r.overall_score ?? -1) < e.min_score) misses.push(`score ${r.overall_score} < ${e.min_score}`);
  if (e.max_score !== undefined && (r.overall_score ?? 101) > e.max_score) misses.push(`score ${r.overall_score} > ${e.max_score}`);
  for (const [key, max] of Object.entries(e.max_dimension ?? {})) {
    const s = r.metrics[key]?.score;
    if (s === undefined || s === null || s > max) misses.push(`${key} ${s} > ${max}`);
  }
  if (r.judge.evidence_validity < 1) misses.push(`invented evidence (validity ${r.judge.evidence_validity})`);
  return misses;
}

const selected = cases.filter((c) => !args.only || c.name === args.only);
mkdirSync("eval-output", { recursive: true });
console.log(`judge ${env.AUDIT_JUDGE_MODEL} (${env.AUDIT_JUDGE_REASONING_EFFORT ?? "temperature 0"}), rubric ${hansaRubric.version}, ${selected.length} case(s)\n`);

// All cases at once: each is an independent judge call.
const results = await Promise.all(
  selected.map(async (c, i) => {
    const input = normalizeCall(
      {
        id: 900000 + i,
        business_id: 1,
        agent_id: 1,
        agent_code: "hrms",
        prompt_code: agentPrompt.prompt_code,
        variables,
        status: "completed",
        call_type: "outbound",
        ended_reason: "hangup",
        duration: 120,
        transcriptions: c.transcript.map(([speaker, text]) => ({ speaker, text })),
        outcome: c.outcome ?? null,
      },
      {},
    );
    const started = Date.now();
    try {
      const { result } = await auditCall(input, { judge, rubric: hansaRubric, agentPrompt, agentLabel: "Hansa (HR)", reviewThreshold: env.AUDIT_REVIEW_THRESHOLD });
      writeFileSync(`eval-output/${c.name}.json`, JSON.stringify(result, null, 2));
      return { c, result, misses: check(c, result), ms: Date.now() - started };
    } catch (e) {
      return { c, result: null, misses: [`error: ${(e as Error).message}`], ms: Date.now() - started };
    }
  }),
);

let passed = 0;
for (const { c, result, misses, ms } of results) {
  if (misses.length === 0) passed++;
  const summary = result
    ? `score=${result.overall_score} ${result.call_success.result}[${result.call_success.failure_reasons.map((f) => f.code).join(",")}] ` +
      `goal=${result.call_goal.result}/${result.call_goal.reason_code} conf=${result.auditor_confidence}`
    : "";
  console.log(`${misses.length === 0 ? "PASS" : "MISS"}  ${c.name.padEnd(24)} ${summary}  (${(ms / 1000).toFixed(1)}s)`);
  for (const m of misses) console.log(`        - ${m}`);
}
console.log(`\n${passed}/${results.length} cases caught. Full results in eval-output/`);
process.exit(passed === results.length ? 0 : 1);

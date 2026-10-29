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
import { env } from "@/env";
import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { agentPrompt, cases, plantedMisses, plantedRow } from "../../fixtures/planted/cases";

const { values: args } = parseArgs({ options: { only: { type: "string" } } });
if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");

const judge = createOpenAIJudge({ apiKey: env.OPENAI_API_KEY, model: env.AUDIT_JUDGE_MODEL, reasoningEffort: env.AUDIT_JUDGE_REASONING_EFFORT });

// v2-only cases plant conditions v1's Hansa rubric doesn't know; `bun run eval:v2` runs them.
const selected = cases.filter((c) => !c.v2_only && (!args.only || c.name === args.only));
mkdirSync("eval-output", { recursive: true });
console.log(`judge ${env.AUDIT_JUDGE_MODEL} (${env.AUDIT_JUDGE_REASONING_EFFORT ?? "temperature 0"}), rubric ${hansaRubric.version}, ${selected.length} case(s)\n`);

// All cases at once: each is an independent judge call.
const results = await Promise.all(
  selected.map(async (c, i) => {
    const input = normalizeCall(plantedRow(c, 900000 + i), {});
    const started = Date.now();
    try {
      const { result } = await auditCall(input, { judge, rubric: hansaRubric, agentPrompt, agentLabel: "Hansa (HR)", reviewThreshold: env.AUDIT_REVIEW_THRESHOLD });
      writeFileSync(`eval-output/${c.name}.json`, JSON.stringify(result, null, 2));
      return { c, result, misses: plantedMisses(c, result), ms: Date.now() - started };
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

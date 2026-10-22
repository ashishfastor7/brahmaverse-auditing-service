/**
 * Records what the real judge returns for one planted case into fixtures/judge/<name>.json, so tests can replay
 * it with `fixtureJudge(name)`. Manual only (one OpenAI call per run); tests never record. Planted cases are
 * synthetic, so a committed fixture never holds a real person's call.
 *
 *   bun run record:fixture --case wrong-salary [--name hansa-wrong-salary]
 */
import { auditCall, type JudgeResponse } from "@/audit/audit-call";
import { JUDGE_FIXTURES_DIR, type JudgeFixture } from "@/audit/judge/fixture-judge";
import { createOpenAIJudge } from "@/audit/judge/openai-judge";
import { normalizeCall } from "@/audit/normalize";
import { hansaRubric } from "@/audit/rubrics/hansa";
import { env } from "@/env";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { agentPrompt, cases, plantedMisses, plantedRow } from "../../fixtures/planted/cases";

const { values: args } = parseArgs({ options: { case: { type: "string" }, name: { type: "string" } } });
const c = cases.find((x) => x.name === args.case);
if (!c) throw new Error(`--case must be one of: ${cases.map((x) => x.name).join(", ")}`);
const name = args.name ?? `hansa-${c.name}`;
if (!/^[a-z0-9-]+$/.test(name)) throw new Error("--name: lowercase letters, digits and dashes only");
if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");

const openai = createOpenAIJudge({
  apiKey: env.OPENAI_API_KEY,
  model: env.AUDIT_JUDGE_MODEL,
  reasoningEffort: env.AUDIT_JUDGE_REASONING_EFFORT,
});
let response: JudgeResponse | undefined;

const input = normalizeCall(plantedRow(c, 900000), {});
const { result } = await auditCall(input, {
  judge: async (call) => (response = await openai(call)),
  rubric: hansaRubric,
  agentPrompt,
  agentLabel: "Hansa (HR)",
  reviewThreshold: env.AUDIT_REVIEW_THRESHOLD,
});

const fixture: JudgeFixture = {
  name,
  case: c.name,
  rubric_version: hansaRubric.version,
  judge_model: response!.model,
  recorded_at: new Date().toISOString(),
  response: response!,
};
mkdirSync(JUDGE_FIXTURES_DIR, { recursive: true });
writeFileSync(join(JUDGE_FIXTURES_DIR, `${name}.json`), `${JSON.stringify(fixture, null, 2)}\n`);

const misses = plantedMisses(c, result);
console.log(
  `${name}: score=${result.overall_score} ${result.call_success.result}[${result.call_success.failure_reasons.map((f) => f.code).join(",")}] ` +
    `goal=${result.call_goal.result}/${result.call_goal.reason_code} model=${response!.model}`,
);
if (misses.length) {
  console.log(`MISSES (the replay test will fail; re-record or drop this fixture):\n${misses.map((m) => `  - ${m}`).join("\n")}`);
  process.exit(1);
}
console.log(`written to fixtures/judge/${name}.json`);

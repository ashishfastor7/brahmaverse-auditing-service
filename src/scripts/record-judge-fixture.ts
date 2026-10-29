/**
 * Records what the real judge returns for one planted case into fixtures/judge/<name>.json (v1) or
 * fixtures/judge/v2/<name>.json (v2), so tests can replay it with `fixtureJudge(name)`. Manual only (one OpenAI call
 * per run); tests never record. Planted cases are synthetic, so a committed fixture never holds a real person's call.
 *
 *   bun run record:fixture --case wrong-salary [--name hansa-wrong-salary]
 *   bun run record:fixture --engine v2 --case agent-loop [--name hansa-agent-loop] [--model <dated id>]
 *     v2 grades on the case agent's seeded v4 scorecard and goal (seeded-config.ts) with AUDIT_V2_JUDGE_MODEL unless --model.
 *     `v2_only` cases can only be recorded with --engine v2.
 */
import { auditCall, type JudgeResponse } from "@/audit/audit-call";
import { fixturesDir, type JudgeFixture } from "@/audit/judge/fixture-judge";
import { createOpenAIJudge } from "@/audit/judge/openai-judge";
import { normalizeCall } from "@/audit/normalize";
import { hansaRubric } from "@/audit/rubrics/hansa";
import { auditCallV2 } from "@/audit/v2/audit-call";
import { toCallRecord } from "@/audit/v2/call-record";
import { JUDGE_PROMPT_VERSION } from "@/audit/v2/judge/prompt";
import { seededDefinitions, seededGoal, seededScorecard } from "@/audit/v2/seeded-config";
import { env } from "@/env";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { agentPrompt, cases, plantedAgent, plantedMisses, plantedMissesV2, plantedRow } from "../../fixtures/planted/cases";

const { values: args } = parseArgs({
  options: { case: { type: "string" }, name: { type: "string" }, engine: { type: "string", default: "v1" }, model: { type: "string" } },
});
const c = cases.find((x) => x.name === args.case);
if (!c) throw new Error(`--case must be one of: ${cases.map((x) => x.name).join(", ")}`);
const engine = args.engine === "v2" ? "v2" : "v1";
if (engine === "v1" && c.v2_only) throw new Error(`${c.name} plants a v2-only condition: use --engine v2`);
const agent = plantedAgent(c);
const name = args.name ?? `${agent.scorecard_id}-${c.name}`;
if (!/^[a-z0-9-]+$/.test(name)) throw new Error("--name: lowercase letters, digits and dashes only");
if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");

const raw = plantedRow(c, 900000);
const input = normalizeCall(raw, {});
let response: JudgeResponse | undefined;
let rubricVersion: string;
let misses: string[];
let summary: string;

if (engine === "v1") {
  const openai = createOpenAIJudge({ apiKey: env.OPENAI_API_KEY, model: env.AUDIT_JUDGE_MODEL, reasoningEffort: env.AUDIT_JUDGE_REASONING_EFFORT });
  const { result } = await auditCall(input, {
    judge: async (call) => (response = await openai(call)),
    rubric: hansaRubric,
    agentPrompt,
    agentLabel: "Hansa (HR)",
    reviewThreshold: env.AUDIT_REVIEW_THRESHOLD,
  });
  rubricVersion = hansaRubric.version;
  misses = plantedMisses(c, result);
  summary =
    `score=${result.overall_score} ${result.call_success.result}[${result.call_success.failure_reasons.map((f) => f.code).join(",")}] ` +
    `goal=${result.call_goal.result}/${result.call_goal.reason_code}`;
} else {
  const model = args.model ?? env.AUDIT_V2_JUDGE_MODEL;
  if (!model) throw new Error("pass --model or set AUDIT_V2_JUDGE_MODEL");
  const openai = createOpenAIJudge({ apiKey: env.OPENAI_API_KEY, model, reasoningEffort: env.AUDIT_V2_JUDGE_REASONING_EFFORT, rawOnInvalidJson: true });
  const scorecard = seededScorecard(agent.scorecard_id);
  const { result } = await auditCallV2(input, toCallRecord(raw), {
    // keep the first answer: a fixture is what the judge said, not what a retry fixed
    judge: async (call) => {
      const r = await openai(call);
      response ??= r;
      return r;
    },
    scorecard,
    goal: seededGoal(agent.agent_code as "hrms" | "caller"),
    weights: Object.fromEntries(scorecard.metrics.map((m) => [m.key, m.weight])),
    definitions: seededDefinitions(),
    instructions: agent.prompt,
    flow: { source: "prompt", text: agent.prompt.system_prompt, reason: "no Vajra conversation on this call" },
    agentLabel: agent.label,
    reviewThreshold: env.AUDIT_REVIEW_THRESHOLD,
  });
  rubricVersion = `${scorecard.scorecard_id}@${scorecard.version}`;
  const firstErrors = result.judge.attempts[0]!.errors;
  misses = [...(firstErrors.length ? [`first answer rejected: ${firstErrors.join("; ")}`] : []), ...plantedMissesV2(c, result)];
  summary =
    `score=${result.score} passed=${result.passed} flags=[${result.flags.map((f) => f.code).join(",")}] ` +
    `system=${result.system_goal.result} business=${result.business_goal?.outcome}/${result.business_goal?.reason_code}`;
}

const fixture: JudgeFixture = {
  name,
  case: c.name,
  rubric_version: rubricVersion,
  judge_model: response!.model,
  recorded_at: new Date().toISOString(),
  ...(engine === "v2" ? { judge_prompt_version: JUDGE_PROMPT_VERSION } : {}),
  response: response!,
};
const dir = fixturesDir(engine);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(fixture, null, 2)}\n`);

console.log(`${name}: ${summary} model=${response!.model}`);
if (misses.length) {
  console.log(`MISSES (the replay test will fail; re-record or drop this fixture):\n${misses.map((m) => `  - ${m}`).join("\n")}`);
  process.exit(1);
}
console.log(`written to ${engine === "v1" ? "fixtures/judge" : "fixtures/judge/v2"}/${name}.json`);

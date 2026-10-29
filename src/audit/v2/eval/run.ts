import type { Judge } from "@/audit/audit-call";
import { normalizeCall } from "@/audit/normalize";
import { type PlantedCase, plantedAgent, plantedMissesV2, plantedRow } from "../../../../fixtures/planted/cases";
import { type AuditResultV2, auditCallV2 } from "../audit-call";
import { toCallRecord } from "../call-record";
import type { GoalConfig, ScorecardVersion } from "../config";
import type { ConditionDefinition } from "../judge/prompt";
import type { AuditContextV2, ContextOrSkip } from "../run-audit";
import {
  type Agreement,
  agreement,
  biggestDisagreements,
  type Disagreement,
  gate,
  type GateStatus,
  type Pair,
  retirementCandidates,
} from "./agreement";
import { expectedFor, type GoldenRow, type Verdict, verdictOf } from "./golden";
import type { Comparison } from "./report";

export type AgentConfig = { scorecard: ScorecardVersion; goal: GoalConfig; definitions: ConditionDefinition[] };

/** A planted case as a v2 audit context, graded on its agent's config (from the audit DB, or seeded in tests). */
export function plantedContext(c: PlantedCase, config: AgentConfig): AuditContextV2 {
  const agent = plantedAgent(c);
  const raw = plantedRow(c, 900000);
  return {
    input: normalizeCall(raw, {}),
    record: toCallRecord(raw),
    agentLabel: agent.label,
    scorecard: config.scorecard,
    goal: config.goal,
    weights: Object.fromEntries(config.scorecard.metrics.map((m) => [m.key, m.weight])),
    definitions: config.definitions,
    instructions: agent.prompt,
    instructionsMissing: null,
    flow: { source: "prompt", text: agent.prompt.system_prompt, reason: "no Vajra conversation on this call" },
  };
}

export type PlantedOutcome = { name: string; ok: boolean; misses: string[] };
/** What a saved report keeps for `--compare`: no text from any call. */
export type EvalData = {
  date: string;
  judge_prompt_version: string;
  judge_model: string | null;
  planted: PlantedOutcome[];
  calls: { call_id: number; verdict: Verdict }[];
};

export type EvalRun = {
  data: EvalData;
  scorecards: string[];
  planted: (PlantedOutcome & { result: AuditResultV2 | null })[];
  pairs: Pair[];
  /** Golden calls that weren't re-audited (skipped, or the judge failed), with why. */
  unaudited: { call_id: number; reason: string }[];
  all: Agreement;
  blind: Agreement;
  gate: GateStatus;
  top: Disagreement[];
  retire: GoldenRow[];
};

/** Runs the tasks with at most `limit` at a time (judge calls), keeping their order. */
export async function pool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, limit) }, async () => {
      while (next < tasks.length) {
        const i = next++;
        out[i] = await tasks[i]!();
      }
    }),
  );
  return out;
}

/**
 * P1-19: audits the planted cases and the golden-set calls with the given judge (`judgeFor(key)`: key `planted-<name>` or
 * `call-<id>`), checks the planted expectations, and computes agreement with the reviewers. Pure apart from the judge.
 */
export async function evaluate(opts: {
  date: string;
  promptVersion: string;
  planted: { case: PlantedCase; context: AuditContextV2 }[];
  golden: { row: GoldenRow; context: AuditContextV2 | null; skip?: string }[];
  judgeFor: (key: string) => Judge;
  reviewThreshold: number;
  concurrency?: number;
}): Promise<EvalRun> {
  const audit = (key: string, ctx: AuditContextV2) =>
    auditCallV2(ctx.input, ctx.record, { ...ctx, judge: opts.judgeFor(key), reviewThreshold: opts.reviewThreshold }).then((r) => r.result);

  type Done =
    | { kind: "planted"; out: EvalRun["planted"][number] }
    | { kind: "pair"; out: Pair }
    | { kind: "unaudited"; out: EvalRun["unaudited"][number] };
  const tasks: (() => Promise<Done>)[] = [
    ...opts.planted.map(({ case: c, context }) => async (): Promise<Done> => {
      try {
        const result = await audit(`planted-${c.name}`, context);
        const misses = plantedMissesV2(c, result);
        return { kind: "planted", out: { name: c.name, ok: misses.length === 0, misses, result } };
      } catch (e) {
        return { kind: "planted", out: { name: c.name, ok: false, misses: [`error: ${(e as Error).message}`], result: null } };
      }
    }),
    ...opts.golden.map(({ row, context, skip }) => async (): Promise<Done> => {
      if (!context) return { kind: "unaudited", out: { call_id: row.call_id, reason: skip ?? "no audit context" } };
      try {
        const result = await audit(`call-${row.call_id}`, context);
        const pair: Pair = { call_id: row.call_id, kind: row.kind, expected: expectedFor(row), verdict: verdictOf(result), row, result };
        return { kind: "pair", out: pair };
      } catch (e) {
        return { kind: "unaudited", out: { call_id: row.call_id, reason: `judge error: ${(e as Error).message}` } };
      }
    }),
  ];
  const done = await pool(tasks, opts.concurrency ?? 4);
  const planted = done.flatMap((d) => (d.kind === "planted" ? [d.out] : []));
  const pairs = done.flatMap((d) => (d.kind === "pair" ? [d.out] : []));
  const unaudited = done.flatMap((d) => (d.kind === "unaudited" ? [d.out] : []));
  const blind = pairs.filter((p) => p.kind === "blind");
  const results = [...planted.map((p) => p.result), ...pairs.map((p) => p.result)].filter((r): r is AuditResultV2 => !!r);

  return {
    data: {
      date: opts.date,
      judge_prompt_version: opts.promptVersion,
      judge_model: results[0]?.judge.model ?? null,
      planted: planted.map(({ name, ok, misses }) => ({ name, ok, misses })),
      calls: pairs.map((p) => ({ call_id: p.call_id, verdict: p.verdict })).sort((a, b) => a.call_id - b.call_id),
    },
    scorecards: [...new Set(results.map((r) => `${r.scorecard.scorecard_id}@${r.scorecard.version}`))].sort(),
    planted,
    pairs,
    unaudited,
    all: agreement(pairs),
    blind: agreement(blind),
    gate: gate(blind),
    top: biggestDisagreements(pairs),
    retire: retirementCandidates(opts.golden.map((g) => g.row)),
  };
}

/**
 * Each golden row with its call's audit context: `sources` are the calls read from voice_call_logs, `load` is
 * `loadAuditContextV2`. A call that is gone, or can't be audited any more, keeps its row with the reason.
 */
export async function goldenContexts(
  rows: GoldenRow[],
  sources: any[],
  load: (raw: any) => Promise<ContextOrSkip>,
): Promise<{ row: GoldenRow; context: AuditContextV2 | null; skip?: string }[]> {
  const out = [];
  for (const row of rows) {
    const raw = sources.find((s) => Number(s.id) === row.call_id);
    if (!raw) {
      out.push({ row, context: null, skip: "not in voice_call_logs (or no transcript)" });
      continue;
    }
    const loaded = await load(raw);
    out.push(loaded.context ? { row, context: loaded.context } : { row, context: null, skip: loaded.skip });
  }
  return out;
}

/** `eval:v2`'s exit code: 1 when a planted case missed, or `--compare` found a regression. */
export const exitCode = (run: Pick<EvalRun, "data">, comparison?: Comparison) =>
  run.data.planted.some((p) => !p.ok) || (comparison?.regressions.length ?? 0) > 0 ? 1 : 0;

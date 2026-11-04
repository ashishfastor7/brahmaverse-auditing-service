import type { BusinessOutcome } from "./config";

/**
 * Blind spot-checks (P2-18, PRD §8 #2, §9): which already-audited calls a reviewer grades without seeing the judge.
 * All pure; `src/db/spot-check.ts` stores the draws and `src/routes/spot-check.ts` serves them.
 */

export const SPOT_CHECKS_PER_AGENT = 5;

/** mulberry32: a small seeded PRNG, so a stored seed gives the same draw again. Returns floats in [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Candidate = { audit_id: number; agent_code: string };
export type Shortfall = { agent_code: string; available: number; wanted: number };

/**
 * Up to `perAgent` random audits per agent (a number, or each agent's own limit, for a top-up). Candidates are sorted by audit id before the seeded shuffle, so the same
 * candidates and seed always give the same picks, whatever order they came in. `agents` lists agents to report as short
 * even when they have no candidates at all.
 */
export function pickSpotChecks(
  candidates: Candidate[],
  seed: number,
  perAgent: number | ((agent: string) => number),
  agents: string[] = [],
): { picks: Candidate[]; shortfall: Shortfall[] } {
  const sorted = [...candidates].sort((a, b) => a.audit_id - b.audit_id);
  const random = seededRandom(seed);
  for (let i = sorted.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [sorted[i], sorted[j]] = [sorted[j]!, sorted[i]!];
  }
  const byAgent = new Map<string, Candidate[]>();
  for (const agent of agents) byAgent.set(agent, []);
  for (const c of sorted) byAgent.set(c.agent_code, [...(byAgent.get(c.agent_code) ?? []), c]);
  const picks: Candidate[] = [];
  const shortfall: Shortfall[] = [];
  for (const [agent_code, list] of [...byAgent.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const wanted = typeof perAgent === "number" ? perAgent : perAgent(agent_code);
    picks.push(...list.slice(0, Math.max(0, wanted)));
    if (list.length < wanted) shortfall.push({ agent_code, available: list.length, wanted });
  }
  return { picks, shortfall };
}

const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;

/** The Monday (IST, PRD §6) of the week `at` falls in, as `YYYY-MM-DD`. */
export function istWeekStart(at: Date): string {
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  const daysSinceMonday = (ist.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() - daysSinceMonday)).toISOString().slice(0, 10);
}

/** The week starting on Monday `weekStart` (IST) as a half-open UTC range. Throws on a date that isn't a Monday. */
export function istWeekRange(weekStart: string): { from: Date; to: Date } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) throw new Error(`week must be YYYY-MM-DD, not ${weekStart}`);
  const monday = new Date(`${weekStart}T00:00:00Z`);
  if (Number.isNaN(monday.getTime()) || monday.toISOString().slice(0, 10) !== weekStart) throw new Error(`${weekStart} isn't a date`);
  if (monday.getUTCDay() !== 1) throw new Error(`${weekStart} isn't a Monday`);
  const from = new Date(monday.getTime() - IST_OFFSET_MS);
  return { from, to: new Date(from.getTime() + 7 * DAY_MS) };
}

export type BlindAnswer = { expected_pass_fail: "PASS" | "FAIL"; expected_business_outcome: BusinessOutcome; expected_failure_codes: string[] };
export type JudgeVerdict = { pass_fail: "PASS" | "FAIL" | null; business_outcome: BusinessOutcome | null; failure_codes: string[] };

/** The reviewer's blind answer against the judge's verdict, field by field (the step 16 gate's three numbers). */
export function compareBlind(answer: BlindAnswer, judge: JudgeVerdict) {
  const same = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
  const result = {
    pass_fail: answer.expected_pass_fail === judge.pass_fail,
    business_outcome: answer.expected_business_outcome === judge.business_outcome,
    failure_codes: same([...new Set(answer.expected_failure_codes)], judge.failure_codes),
  };
  return { ...result, agree: result.pass_fail && result.business_outcome && result.failure_codes };
}

import type { BusinessOutcome } from "./config";

export type GoalRate = {
  /** Calls where the goal applies: every outcome except NOT_APPLICABLE. */
  applicable: number;
  /** Achieved ÷ applicable, as a percentage with one decimal; null when nothing applies. */
  rate: number | null;
  /** Partial ÷ applicable, shown next to the rate; Partial never counts as achieved. */
  partial_share: number | null;
};

const pct = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 1000) / 10);

/**
 * P1-6, PRD §3.3 (decided 2026-10-22): goal rate = achieved ÷ applicable calls, N/A excluded, and the Partial share
 * separately. Audits without a business goal (the judge gave no usable answer) are left out. Pure.
 */
export function goalRate(outcomes: (BusinessOutcome | null)[]): GoalRate {
  const applicable = outcomes.filter((o) => o !== null && o !== "NOT_APPLICABLE");
  return {
    applicable: applicable.length,
    rate: pct(applicable.filter((o) => o === "ACHIEVED").length, applicable.length),
    partial_share: pct(applicable.filter((o) => o === "PARTIAL").length, applicable.length),
  };
}

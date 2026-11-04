import type { CheckResult } from "./audit-call";
import type { BusinessOutcome } from "./config";
import type { SystemCheckCode } from "./system-checks";

/**
 * P2-4, PRD §5 item 7: a reviewer's answer to one v2 audit. `agree` and `flag` carry only a note. A `dispute` gives the
 * right answer for any number of items, each optionally with its own note in `item_notes`:
 * - `corrected_scores`: metric key → the right score (null = N/A);
 * - `corrected_checks`: S1–S4 → the right result;
 * - `expected_business_outcome`;
 * - `expected_failure_codes`: the full right list ("this wasn't a loop" leaves AGENT_LOOP out; "this was a
 *   hallucination" adds CRITICAL_HALLUCINATION).
 * Anything left out means "the audit was right" (migration 0013).
 */
export type ReviewInput = {
  verdict: "agree" | "dispute" | "flag";
  corrected_scores?: Record<string, number | null>;
  corrected_checks?: Partial<Record<SystemCheckCode, CheckResult>>;
  expected_business_outcome?: BusinessOutcome | null;
  expected_failure_codes?: string[] | null;
  item_notes?: Record<string, string>;
  note?: string | null;
};

/** What a review is checked against: the audit as stored, and the codes its scorecard could flag. */
export type ReviewTarget = {
  metrics: { key: string; max: number; score: number | null; n_a: boolean }[];
  checks: Record<SystemCheckCode, { result: CheckResult }>;
  business_outcome: BusinessOutcome | null;
  /** Outcomes the audit's goal offers (PARTIAL only with partial-success criteria). */
  outcomes: BusinessOutcome[];
  failure_codes: string[];
  /** Codes a reviewer may add: the scorecard's conditions plus the rule codes. */
  known_codes: string[];
};

const CHECK_CODES: SystemCheckCode[] = ["S1", "S2", "S3", "S4"];
const RESULTS: CheckResult[] = ["PASS", "FAIL", "NOT_APPLICABLE"];

/** The `item_notes` key of each item a dispute changes, in a stable order. Pure. */
export function disputedItems(input: ReviewInput, target: ReviewTarget): string[] {
  const items: string[] = [];
  for (const [key, score] of Object.entries(input.corrected_scores ?? {})) {
    const m = target.metrics.find((x) => x.key === key);
    const current = m && !m.n_a ? m.score : null;
    if (!m || score !== current) items.push(`metric:${key}`);
  }
  for (const [code, result] of Object.entries(input.corrected_checks ?? {})) {
    if (target.checks[code as SystemCheckCode]?.result !== result) items.push(`check:${code}`);
  }
  if (input.expected_business_outcome != null && input.expected_business_outcome !== target.business_outcome) items.push("business_outcome");
  if (input.expected_failure_codes != null) {
    const expected = new Set(input.expected_failure_codes);
    const actual = new Set(target.failure_codes);
    for (const code of [...new Set([...expected, ...actual])].sort()) if (expected.has(code) !== actual.has(code)) items.push(`code:${code}`);
  }
  return items;
}

/** Why a review can't be saved as given; empty when it can. Pure. */
export function validateReview(input: ReviewInput, target: ReviewTarget): string[] {
  const errors: string[] = [];
  const hasCorrections =
    Object.keys(input.corrected_scores ?? {}).length > 0 ||
    Object.keys(input.corrected_checks ?? {}).length > 0 ||
    input.expected_business_outcome != null ||
    input.expected_failure_codes != null;
  const notes = Object.keys(input.item_notes ?? {});

  if (input.verdict !== "dispute") {
    const kind = input.verdict === "agree" ? "an agree" : "a flag";
    if (hasCorrections) errors.push(`${kind} review can't correct anything; dispute instead`);
    if (notes.length) errors.push(`${kind} review has no item notes; use the note`);
    return errors;
  }

  for (const [key, score] of Object.entries(input.corrected_scores ?? {})) {
    const m = target.metrics.find((x) => x.key === key);
    if (!m) errors.push(`metric ${key} isn't part of this audit`);
    else if (score !== null && (!Number.isFinite(score) || score < 0 || score > m.max)) errors.push(`metric ${key} must be scored 0 to ${m.max}, or N/A`);
  }
  for (const [code, result] of Object.entries(input.corrected_checks ?? {})) {
    if (!CHECK_CODES.includes(code as SystemCheckCode)) errors.push(`${code} isn't a system check`);
    else if (!RESULTS.includes(result as CheckResult)) errors.push(`${code} can't be ${result}`);
  }
  if (input.expected_business_outcome != null && !target.outcomes.includes(input.expected_business_outcome))
    errors.push(`${input.expected_business_outcome} isn't an outcome this agent's goal offers`);
  const unknown = (input.expected_failure_codes ?? []).filter((c) => !target.known_codes.includes(c));
  if (unknown.length) errors.push(`${unknown.join(", ")} isn't a failure condition on this scorecard`);
  if (errors.length) return errors;

  const disputed = disputedItems(input, target);
  if (disputed.length === 0) errors.push("a dispute must change at least one item; to accept the audit, agree");
  const stray = notes.filter((k) => !disputed.includes(k));
  if (stray.length) errors.push(`notes on items that aren't disputed: ${stray.join(", ")}`);
  return errors;
}

import type { AuditView, BusinessOutcome, CheckCode, CheckResult, MetricOutcome, ReviewInput } from "../api";

/**
 * The v2 call page's pure logic, kept free of React so `bun test` (from the repo root) can check it:
 * `src/audit/v2/dashboard-logic.test.ts` runs these against the server's own `validateReview`.
 */

/** One thing the reviewer disputes, keyed as `review.item_notes` keys them (migration 0016). */
export type DisputeItem =
  | { key: `metric:${string}`; kind: "metric"; metric: string; value: string; note: string }
  | { key: `check:${CheckCode}`; kind: "check"; check: CheckCode; value: CheckResult; note: string }
  | { key: "business_outcome"; kind: "outcome"; value: BusinessOutcome; note: string }
  | { key: `code:${string}`; kind: "code"; code: string; note: string };

export const CHECKS: CheckCode[] = ["S1", "S2", "S3", "S4"];

/** A new dispute item, pre-set to what the audit says (so the reviewer has to change it). */
export function newItem(key: string, view: AuditView): DisputeItem {
  const r = view.audit.result!;
  if (key.startsWith("metric:")) {
    const m = r.metrics.find((x) => `metric:${x.key}` === key)!;
    return { key: `metric:${m.key}`, kind: "metric", metric: m.key, value: m.n_a || m.score === null ? "na" : String(m.score), note: "" };
  }
  if (key.startsWith("check:")) {
    const c = key.slice(6) as CheckCode;
    return { key: `check:${c}`, kind: "check", check: c, value: r.checks[c].result, note: "" };
  }
  if (key === "business_outcome") return { key, kind: "outcome", value: r.business_goal!.outcome, note: "" };
  return { key: key as `code:${string}`, kind: "code", code: key.slice(5), note: "" };
}

/** Items whose answer still equals the audit's, so they dispute nothing yet (failure codes always do). */
export function unchangedItems(items: DisputeItem[], view: AuditView): DisputeItem[] {
  const r = view.audit.result!;
  return items.filter((i) => {
    if (i.kind === "metric") {
      const m = r.metrics.find((x) => x.key === i.metric)!;
      return i.value === (m.n_a || m.score === null ? "na" : String(m.score));
    }
    if (i.kind === "check") return i.value === r.checks[i.check].result;
    if (i.kind === "outcome") return i.value === r.business_goal?.outcome;
    return false;
  });
}

/** The review the dispute dialog saves. */
export function disputeInput(items: DisputeItem[], view: AuditView, note: string): ReviewInput {
  const flagged = view.audit.result!.flags.map((f) => f.code);
  const codes = items.filter((i) => i.kind === "code").map((i) => i.code);
  const input: ReviewInput = { verdict: "dispute", note: note.trim() || null };
  for (const i of items) {
    if (i.kind === "metric") input.corrected_scores = { ...input.corrected_scores, [i.metric]: i.value === "na" ? null : Number(i.value) };
    if (i.kind === "check") input.corrected_checks = { ...input.corrected_checks, [i.check]: i.value };
    if (i.kind === "outcome") input.expected_business_outcome = i.value;
  }
  // The full right list: flagged codes the reviewer named are removed, unflagged ones they named are added.
  if (codes.length) input.expected_failure_codes = [...flagged.filter((c) => !codes.includes(c)), ...codes.filter((c) => !flagged.includes(c))];
  const notes = Object.fromEntries(items.filter((i) => i.note.trim()).map((i) => [i.key, i.note.trim()]));
  if (Object.keys(notes).length) input.item_notes = notes;
  return input;
}

/** The scorecard order: lowest share of the scale first; N/A last. A metric zeroed by a Major flag sorts as 0. */
export function sortMetrics(metrics: MetricOutcome[]): MetricOutcome[] {
  const share = (m: MetricOutcome) => (m.n_a || m.score === null ? Infinity : m.zeroed_by ? 0 : m.score / m.max);
  return [...metrics].sort((a, b) => share(a) - share(b) || a.name.localeCompare(b.name));
}

import type { AuditResultV2, CheckResult } from "../audit-call";
import type { BusinessOutcome } from "../config";
import type { SystemCheckCode } from "../system-checks";

export const CHECK_CODES: SystemCheckCode[] = ["S1", "S2", "S3", "S4"];

/**
 * One golden-set row (P1-19): the latest agree / dispute / blind review of a call with `in_golden_set` (migration 0013),
 * with the audit the reviewer looked at.
 *
 * The expected values and corrections mean "the reviewer's answer". On a `normal` review a null value or a missing key
 * means the reviewer accepted the audit's value; on a `blind` review it means the reviewer didn't give one.
 */
export type GoldenRow = {
  review_id: number;
  audit_id: number;
  call_id: number;
  agent_code: string | null;
  kind: "normal" | "blind";
  verdict: "agree" | "dispute";
  note: string | null;
  created_at: string;
  in_golden_set: boolean;
  expected_pass_fail: "PASS" | "FAIL" | null;
  expected_business_outcome: BusinessOutcome | null;
  expected_failure_codes: string[] | null;
  /** Metric key → the right score, or null for "not applicable". */
  corrected_scores: Record<string, number | null> | null;
  corrected_checks: Partial<Record<SystemCheckCode, CheckResult>> | null;
  /** The reviewed audit's stored result; null when it has none (a blind review only needs its own answers). */
  audit: AuditResultV2 | null;
};

/** What the reviewer says is right for a call. Null / missing: not known, so not measured. */
export type Expected = {
  pass_fail: "PASS" | "FAIL" | null;
  business_outcome: BusinessOutcome | null;
  failure_codes: string[] | null;
  metrics: Record<string, number | null>;
  checks: Partial<Record<SystemCheckCode, CheckResult>>;
};

/**
 * What a v2 audit decided, without any text: what the eval compares and what a report stores for `--compare`.
 * Metrics that need data that doesn't exist yet are left out (nothing to agree on).
 */
export type Verdict = {
  pass_fail: "PASS" | "FAIL" | null;
  business_outcome: BusinessOutcome | null;
  failure_codes: string[];
  severities: Record<string, "critical" | "major" | "minor">;
  metrics: Record<string, number | null>;
  checks: Record<SystemCheckCode, CheckResult>;
};

export function verdictOf(r: AuditResultV2): Verdict {
  return {
    pass_fail: r.passed === null ? null : r.passed ? "PASS" : "FAIL",
    business_outcome: r.business_goal?.outcome ?? null,
    failure_codes: r.flags.map((f) => f.code).sort(),
    severities: Object.fromEntries(r.flags.map((f) => [f.code, f.severity])),
    metrics: Object.fromEntries(r.metrics.filter((m) => m.source !== "unavailable").map((m) => [m.key, m.n_a ? null : m.score])),
    checks: Object.fromEntries(CHECK_CODES.map((c) => [c, r.checks[c].result])) as Record<SystemCheckCode, CheckResult>,
  };
}

/** A plain agree: a normal review that accepted the whole audit, with no correction. */
export const isPlainAgree = (row: GoldenRow) =>
  row.kind === "normal" &&
  row.verdict === "agree" &&
  row.expected_pass_fail === null &&
  row.expected_business_outcome === null &&
  row.expected_failure_codes === null &&
  Object.keys(row.corrected_scores ?? {}).length === 0 &&
  Object.keys(row.corrected_checks ?? {}).length === 0;

/** The reviewer's answer: the reviewed audit's values with the corrections applied (normal), or only what they entered (blind). */
export function expectedFor(row: GoldenRow): Expected {
  const audit = row.kind === "normal" && row.audit ? verdictOf(row.audit) : null;
  return {
    pass_fail: row.expected_pass_fail ?? audit?.pass_fail ?? null,
    business_outcome: row.expected_business_outcome ?? audit?.business_outcome ?? null,
    failure_codes: row.expected_failure_codes ? [...row.expected_failure_codes].sort() : (audit?.failure_codes ?? null),
    metrics: { ...audit?.metrics, ...row.corrected_scores },
    checks: { ...audit?.checks, ...row.corrected_checks },
  };
}

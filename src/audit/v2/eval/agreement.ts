import type { AuditResultV2 } from "../audit-call";
import { CHECK_CODES, type Expected, type GoldenRow, isPlainAgree, type Verdict } from "./golden";

/** One golden call: the reviewer's answer and what the current judge decided (`result` only for the console's reasons). */
export type Pair = {
  call_id: number;
  kind: GoldenRow["kind"];
  expected: Expected;
  verdict: Verdict;
  row?: GoldenRow;
  result?: AuditResultV2;
};

export type Ratio = { agree: number; total: number; rate: number | null };
export type CodeStats = { tp: number; fp: number; fn: number; precision: number | null; recall: number | null };

export type Agreement = {
  calls: number;
  /** Within one scale point; both N/A agrees, N/A against a score doesn't. */
  metrics: Record<string, Ratio>;
  checks: Record<string, Ratio>;
  pass_fail: Ratio;
  business_outcome: Ratio;
  /** Same set of failure codes on the call (the step 16 gate's "failure codes" number). */
  failure_code_sets: Ratio;
  codes: Record<string, CodeStats>;
};

const ratio = (agree: number, total: number): Ratio => ({ agree, total, rate: total ? agree / total : null });
const div = (a: number, b: number) => (b ? a / b : null);

/** The agreement numbers over golden calls (P1-19). Values the reviewer didn't give, or the judge no longer scores, are skipped. */
export function agreement(pairs: Pair[]): Agreement {
  const tally = new Map<string, [number, number]>();
  const count = (key: string, ok: boolean) => {
    const t = tally.get(key) ?? [0, 0];
    tally.set(key, [t[0] + (ok ? 1 : 0), t[1] + 1]);
  };
  const codes: Record<string, CodeStats> = {};
  const code = (c: string) => (codes[c] ??= { tp: 0, fp: 0, fn: 0, precision: null, recall: null });

  for (const { expected: e, verdict: v } of pairs) {
    for (const [key, want] of Object.entries(e.metrics)) {
      if (!(key in v.metrics)) continue;
      const got = v.metrics[key]!;
      count(`metric:${key}`, want === null || got === null ? want === got : Math.abs(want - got) <= 1);
    }
    for (const c of CHECK_CODES) if (e.checks[c]) count(`check:${c}`, e.checks[c] === v.checks[c]);
    if (e.pass_fail) count("pass_fail", e.pass_fail === v.pass_fail);
    if (e.business_outcome) count("business_outcome", e.business_outcome === v.business_outcome);
    if (e.failure_codes) {
      const want = new Set(e.failure_codes);
      const got = new Set(v.failure_codes);
      count("failure_code_sets", want.size === got.size && [...want].every((c) => got.has(c)));
      for (const c of got) want.has(c) ? code(c).tp++ : code(c).fp++;
      for (const c of want) if (!got.has(c)) code(c).fn++;
    }
  }
  for (const s of Object.values(codes)) Object.assign(s, { precision: div(s.tp, s.tp + s.fp), recall: div(s.tp, s.tp + s.fn) });

  const get = (key: string) => ratio(...(tally.get(key) ?? [0, 0]));
  const prefixed = (prefix: string) =>
    Object.fromEntries(
      [...tally.keys()]
        .filter((k) => k.startsWith(prefix))
        .sort()
        .map((k) => [k.slice(prefix.length), get(k)]),
    );
  return {
    calls: pairs.length,
    metrics: prefixed("metric:"),
    checks: prefixed("check:"),
    pass_fail: get("pass_fail"),
    business_outcome: get("business_outcome"),
    failure_code_sets: get("failure_code_sets"),
    codes: Object.fromEntries(Object.entries(codes).sort(([a], [b]) => a.localeCompare(b))),
  };
}

export const GATE = { blind: 30, agreement: 0.85, critical_precision: 0.9 };
export type GateStatus = { met: boolean; parts: { label: string; value: string; ok: boolean }[] };

const pct = (r: number | null) => (r === null ? "n/a" : `${Math.round(r * 1000) / 10}%`);

/**
 * P1-21's switch-over gate, on blind spot-checks only: at least 30, at least 85% agreement on pass/fail, business outcome
 * and failure codes, and no Critical code (as the judge rated it) below 90% precision.
 */
export function gate(blind: Pair[]): GateStatus {
  const a = agreement(blind);
  const at = (label: string, r: Ratio) => ({
    label,
    value: `${pct(r.rate)} (${r.agree}/${r.total})`,
    ok: r.rate !== null && r.rate >= GATE.agreement,
  });
  const critical = new Set(
    blind.flatMap((p) =>
      Object.entries(p.verdict.severities)
        .filter(([, s]) => s === "critical")
        .map(([c]) => c),
    ),
  );
  const parts = [
    { label: "blind spot-checks", value: `${blind.length}/${GATE.blind}`, ok: blind.length >= GATE.blind },
    at("pass/fail", a.pass_fail),
    at("business outcome", a.business_outcome),
    at("failure codes", a.failure_code_sets),
    ...[...critical].sort().map((c) => {
      const precision = a.codes[c]?.precision ?? null;
      return { label: `${c} precision (Critical)`, value: pct(precision), ok: precision === null || precision >= GATE.critical_precision };
    }),
  ];
  return { met: parts.every((p) => p.ok), parts };
}

export type Disagreement = {
  call_id: number;
  review_id: number | null;
  kind: GoldenRow["kind"];
  weight: number;
  /** Structured, no text from the call: safe for the saved report. */
  diffs: string[];
  /** The judge's reasons for the items it disagreed on, and the reviewer's note: console only. */
  judge_reasons: string[];
  note: string | null;
};

/** The golden calls with the biggest disagreements: pass/fail 3, business outcome 2, each wrong code 2, each check 1, each metric point beyond 1. */
export function biggestDisagreements(pairs: Pair[], n = 5): Disagreement[] {
  const out: Disagreement[] = [];
  for (const { call_id, kind, expected: e, verdict: v, row, result } of pairs) {
    let weight = 0;
    const diffs: string[] = [];
    const reasons: string[] = [];
    const show = (x: unknown) => (x === null || x === undefined ? "n/a" : String(x));
    if (e.pass_fail && e.pass_fail !== v.pass_fail) {
      weight += 3;
      diffs.push(`pass/fail: judge ${show(v.pass_fail)}, reviewer ${e.pass_fail}`);
      if (result?.call_summary) reasons.push(`summary: ${result.call_summary}`);
    }
    if (e.business_outcome && e.business_outcome !== v.business_outcome) {
      weight += 2;
      diffs.push(`business outcome: judge ${show(v.business_outcome)}, reviewer ${e.business_outcome}`);
      if (result?.business_goal) reasons.push(`business outcome: ${result.business_goal.reason}`);
    }
    if (e.failure_codes) {
      for (const c of v.failure_codes.filter((x) => !e.failure_codes!.includes(x))) {
        weight += 2;
        diffs.push(`${c}: judge only`);
        const f = result?.flags.find((x) => x.code === c);
        if (f) reasons.push(`${c}: ${f.reason}`);
      }
      for (const c of e.failure_codes.filter((x) => !v.failure_codes.includes(x))) {
        weight += 2;
        diffs.push(`${c}: reviewer only`);
      }
    }
    for (const c of CHECK_CODES) {
      if (!e.checks[c] || e.checks[c] === v.checks[c]) continue;
      weight += 1;
      diffs.push(`${c}: judge ${v.checks[c]}, reviewer ${e.checks[c]}`);
      if (result) reasons.push(`${c}: ${result.checks[c].reason}`);
    }
    for (const [key, want] of Object.entries(e.metrics)) {
      if (!(key in v.metrics)) continue;
      const got = v.metrics[key]!;
      const gap = want === null || got === null ? (want === got ? 0 : 2) : Math.abs(want - got) - 1;
      if (gap <= 0) continue;
      weight += gap;
      diffs.push(`${key}: judge ${show(got)}, reviewer ${show(want)}`);
      const m = result?.metrics.find((x) => x.key === key);
      if (m) reasons.push(`${key}: ${m.reason}`);
    }
    if (weight > 0)
      out.push({ call_id, review_id: row?.review_id ?? null, kind, weight, diffs, judge_reasons: reasons, note: row?.note ?? null });
  }
  return out.sort((a, b) => b.weight - a.weight || a.call_id - b.call_id).slice(0, n);
}

export const GOLDEN_CAP = 150;

/**
 * Over the cap, the oldest plain agrees, as many as the set is over: candidates to set `in_golden_set = false`. Blind rows
 * and disputes (including those that led to a rubric change) are never offered.
 */
export function retirementCandidates(rows: GoldenRow[], cap = GOLDEN_CAP): GoldenRow[] {
  if (rows.length <= cap) return [];
  return rows
    .filter(isPlainAgree)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.review_id - b.review_id)
    .slice(0, rows.length - cap);
}

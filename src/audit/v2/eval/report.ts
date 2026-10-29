import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Agreement, agreement, type Pair, type Ratio } from "./agreement";
import type { CacheStats } from "./judge-cache";
import type { EvalData, EvalRun } from "./run";

export const EVALS_DIR = "docs/evals";

/** Where a run is saved. A `--draft` run gets its own file, so it never replaces the published baseline `--compare` reads. */
export const reportPath = (date: string, promptVersion: string, draft = false, dir = EVALS_DIR) =>
  `${dir}/${date}-${promptVersion}${draft ? "-draft" : ""}.md`;
const DATA_FENCE = "```json eval-data";

const pct = (r: number | null) => (r === null ? "n/a" : `${Math.round(r * 1000) / 10}%`);
const ratio = (r: Ratio) => (r.total ? `${pct(r.rate)} (${r.agree}/${r.total})` : "n/a");
/** PRD §9 success metric: judge agreement per metric, within one scale point, on the golden set. */
export const METRIC_TARGET = 0.85;

/** Every agreement number by name, for `--compare`. Rates only; null when there was nothing to measure. */
export function agreementNumbers(a: Agreement): Record<string, number | null> {
  return {
    "pass/fail": a.pass_fail.rate,
    "business outcome": a.business_outcome.rate,
    "failure codes (same set)": a.failure_code_sets.rate,
    ...Object.fromEntries(Object.entries(a.metrics).map(([k, r]) => [`metric ${k}`, r.rate])),
    ...Object.fromEntries(Object.entries(a.checks).map(([k, r]) => [`check ${k}`, r.rate])),
    ...Object.fromEntries(
      Object.entries(a.codes).flatMap(([c, s]) => [
        [`precision ${c}`, s.precision],
        [`recall ${c}`, s.recall],
      ]),
    ),
  };
}

export type Comparison = { against: string; compared_calls: number; regressions: string[] };

/**
 * `eval:v2 --compare` (P1-19): a planted case that passed in `old` and fails now, or any agreement number (all golden
 * calls, and blind only) lower than `old`'s. Both runs are measured on the calls they share, against today's reviews.
 */
export function compareRuns(old: EvalData, current: EvalData, pairs: Pair[], against: string): Comparison {
  const regressions: string[] = [];
  for (const p of old.planted) {
    const now = current.planted.find((x) => x.name === p.name);
    if (p.ok && now && !now.ok) regressions.push(`planted ${p.name} now fails: ${now.misses.join("; ")}`);
  }
  const oldVerdicts = new Map(old.calls.map((c) => [c.call_id, c.verdict]));
  const shared = pairs.filter((p) => oldVerdicts.has(p.call_id));
  const before = shared.map((p) => ({ ...p, verdict: oldVerdicts.get(p.call_id)! }));
  for (const [label, kinds] of [
    ["all", ["normal", "blind"]],
    ["blind", ["blind"]],
  ] as [string, string[]][]) {
    const was = agreementNumbers(agreement(before.filter((p) => kinds.includes(p.kind))));
    const now = agreementNumbers(agreement(shared.filter((p) => kinds.includes(p.kind))));
    for (const [name, w] of Object.entries(was)) {
      const n = now[name];
      if (w !== null && n !== null && n !== undefined && n < w - 1e-9)
        regressions.push(`${label}: ${name} dropped from ${pct(w)} to ${pct(n)}`);
    }
  }
  return { against, compared_calls: shared.length, regressions };
}

/** The saved report to compare with: a path, or the newest `docs/evals/*-<version>.md`. */
export function findReport(versionOrPath: string, dir = EVALS_DIR): string {
  if (versionOrPath.endsWith(".md")) {
    if (!existsSync(versionOrPath)) throw new Error(`no report at ${versionOrPath}`);
    return versionOrPath;
  }
  const name = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(`-${versionOrPath}.md`) && /^\d{4}-\d{2}-\d{2}-/.test(f))
        .sort()
        .at(-1)
    : undefined;
  if (!name) throw new Error(`no saved eval for judge prompt version ${versionOrPath} in ${dir}/`);
  return join(dir, name);
}

export function parseReport(markdown: string): EvalData {
  const start = markdown.indexOf(`${DATA_FENCE}\n`);
  const end = markdown.indexOf("\n```", start + DATA_FENCE.length);
  if (start < 0 || end < 0) throw new Error("report has no eval-data block");
  return JSON.parse(markdown.slice(start + DATA_FENCE.length + 1, end));
}

export const readReport = (path: string) => parseReport(readFileSync(path, "utf8"));

function agreementSection(a: Agreement): string[] {
  if (a.calls === 0) return ["No calls.", ""];
  const lines = [
    `| | Agreement |`,
    `|---|---|`,
    `| Pass/fail (exact) | ${ratio(a.pass_fail)} |`,
    `| Business outcome (exact) | ${ratio(a.business_outcome)} |`,
    `| Failure codes (same set) | ${ratio(a.failure_code_sets)} |`,
    ...Object.entries(a.metrics).map(
      ([k, r]) => `| Metric ${k} (within 1) | ${ratio(r)}${r.rate !== null && r.rate < METRIC_TARGET ? " · below the 85% target" : ""} |`,
    ),
    ...Object.entries(a.checks).map(([k, r]) => `| Check ${k} (exact) | ${ratio(r)} |`),
    "",
  ];
  const codes = Object.entries(a.codes);
  if (codes.length) {
    lines.push("| Failure code | Precision | Recall | TP | FP | FN |", "|---|---|---|---|---|---|");
    for (const [c, s] of codes) lines.push(`| ${c} | ${pct(s.precision)} | ${pct(s.recall)} | ${s.tp} | ${s.fp} | ${s.fn} |`);
    lines.push("");
  }
  return lines;
}

/**
 * The saved report (docs/evals/<date>-<version>.md). Only ids, codes, keys, enum values and numbers: never transcripts,
 * names, quotes, judge reasons or reviewer notes (those go to the console).
 */
export function renderReport(run: EvalRun, extras: { cache: CacheStats; comparison?: Comparison; draft?: boolean }): string {
  const { data } = run;
  const plantedOk = data.planted.filter((p) => p.ok).length;
  const lines = [
    `# v2 judge eval · ${data.date} · ${data.judge_prompt_version}${extras.draft ? " · drafts" : ""}`,
    "",
    `- Judge model: ${data.judge_model ?? "n/a"}; scorecards: ${run.scorecards.join(", ") || "n/a"}`,
    ...(extras.draft
      ? ["- Graded with the agents' unpublished scorecard and goal drafts, where they exist. Publish only if --compare passed."]
      : []),
    `- Judge calls: ${extras.cache.misses} new, ${extras.cache.hits} cached`,
    `- Planted cases: ${plantedOk}/${data.planted.length} pass`,
    `- Golden set: ${run.pairs.length} calls audited (${run.blind.calls} blind)${run.unaudited.length ? `, ${run.unaudited.length} not audited` : ""}`,
    "",
    "## Planted cases",
    "",
    "| Case | Result | Misses |",
    "|---|---|---|",
    ...data.planted.map((p) => `| ${p.name} | ${p.ok ? "pass" : "**MISS**"} | ${p.misses.join("; ").replaceAll("|", "/")} |`),
    "",
    "## Golden set: all reviews",
    "",
    ...agreementSection(run.all),
    "## Blind spot-checks only",
    "",
    ...agreementSection(run.blind),
    `## Step 16 gate: ${run.gate.met ? "met" : "not met"}`,
    "",
    "| Part | Value | OK |",
    "|---|---|---|",
    ...run.gate.parts.map((p) => `| ${p.label} | ${p.value} | ${p.ok ? "yes" : "no"} |`),
    "",
    "## Biggest disagreements",
    "",
    ...(run.top.length
      ? run.top.map((d) => `- call ${d.call_id} (review ${d.review_id ?? "-"}, ${d.kind}, weight ${d.weight}): ${d.diffs.join("; ")}`)
      : ["None."]),
    "",
  ];
  if (run.unaudited.length) {
    lines.push("## Golden calls not audited", "", ...run.unaudited.map((u) => `- call ${u.call_id}: ${u.reason}`), "");
  }
  if (run.retire.length) {
    lines.push(
      `## Retirement candidates (golden set over 150)`,
      "",
      "Oldest plain agrees; set `in_golden_set = false` on these reviews to keep the set at 150.",
      "",
      ...run.retire.map((r) => `- review ${r.review_id} (call ${r.call_id}, ${r.created_at.slice(0, 10)})`),
      "",
    );
  }
  if (extras.comparison) {
    const c = extras.comparison;
    lines.push(
      `## Compared with ${c.against}: ${c.regressions.length ? "FAILED" : "passed"}`,
      "",
      `${c.compared_calls} golden calls in both runs.`,
      "",
      ...(c.regressions.length ? c.regressions.map((r) => `- ${r}`) : ["No planted case broke and no agreement number dropped."]),
      "",
    );
  }
  lines.push("## Data (read by `--compare`)", "", DATA_FENCE, JSON.stringify(data), "```", "");
  return lines.join("\n");
}

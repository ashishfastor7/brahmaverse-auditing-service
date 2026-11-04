/**
 * The admin editors' pure logic (P1-18): what a save sends, and how a change reads. No React and no imports, so
 * `src/dashboard-admin-logic.test.ts` can test it under `bun test` and the root `tsc` can check it. The shapes match
 * `api.ts` structurally.
 */

type Severity = "critical" | "major" | "minor";
type Anchors = { "0": string; "5": string; "10": string };
type MetricFields = {
  key: string;
  name: string;
  description: string;
  rubric: { checks: string; anchors: Anchors };
  applicability: string;
  auto_fail: boolean;
  weight: number;
};
type ConditionFields = { condition_code: string; enabled: boolean; severity: Severity; metric_key: string | null };
export type ScorecardFields = { pass_threshold: number; metrics: MetricFields[]; conditions: ConditionFields[] };

export type ScorecardPatch = {
  pass_threshold?: number;
  metrics?: {
    key: string;
    name?: string;
    description?: string;
    rubric?: { checks?: string; anchors?: Record<string, string> };
    applicability?: string;
    auto_fail?: boolean;
    weight?: number;
  }[];
  conditions?: { code: string; enabled?: boolean; severity?: Severity; metric_key?: string | null }[];
};

/**
 * What saving a scorecard draft sends: only what differs from the saved draft, or null when nothing does. A condition
 * the saved draft doesn't have (attached from the library) goes with all its values.
 */
export function scorecardPatch(saved: ScorecardFields, e: ScorecardFields): ScorecardPatch | null {
  const patch: ScorecardPatch = {};
  if (e.pass_threshold !== saved.pass_threshold) patch.pass_threshold = e.pass_threshold;
  const metrics: NonNullable<ScorecardPatch["metrics"]> = [];
  for (const m of e.metrics) {
    const s = saved.metrics.find((x) => x.key === m.key);
    if (!s) continue; // metrics can't be added here
    const p: (typeof metrics)[number] = { key: m.key };
    if (m.name !== s.name) p.name = m.name;
    if (m.description !== s.description) p.description = m.description;
    if (m.applicability !== s.applicability) p.applicability = m.applicability;
    if (m.auto_fail !== s.auto_fail) p.auto_fail = m.auto_fail;
    if (m.weight !== s.weight) p.weight = m.weight;
    const anchors = (["0", "5", "10"] as const).filter((a) => m.rubric.anchors[a] !== s.rubric.anchors[a]);
    if (m.rubric.checks !== s.rubric.checks || anchors.length)
      p.rubric = {
        ...(m.rubric.checks !== s.rubric.checks ? { checks: m.rubric.checks } : {}),
        ...(anchors.length ? { anchors: Object.fromEntries(anchors.map((a) => [a, m.rubric.anchors[a]])) } : {}),
      };
    if (Object.keys(p).length > 1) metrics.push(p);
  }
  if (metrics.length) patch.metrics = metrics;
  const conditions = e.conditions
    .filter((c) => {
      const s = saved.conditions.find((x) => x.condition_code === c.condition_code);
      return !s || s.enabled !== c.enabled || s.severity !== c.severity || s.metric_key !== c.metric_key;
    })
    .map((c) => ({ code: c.condition_code, enabled: c.enabled, severity: c.severity, metric_key: c.metric_key }));
  if (conditions.length) patch.conditions = conditions;
  return Object.keys(patch).length ? patch : null;
}

type Outcome = "ACHIEVED" | "PARTIAL" | "NOT_ACHIEVED" | "NOT_APPLICABLE";
export type GoalFields = {
  name: string;
  description: string;
  success_criteria: string[];
  partial_success: string[];
  not_applicable_when: string[];
  required_outputs: string[];
  reason_codes: Partial<Record<Outcome, string[]>>;
  system_checks: { silence_limit_s: number; required_variables: string[]; flow_steps: string[] | null };
};
export type GoalPatch = Partial<Omit<GoalFields, "system_checks">> & {
  system_checks?: { required_variables?: string[]; flow_steps?: string[] | null };
};

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const OUTCOMES: Outcome[] = ["ACHIEVED", "PARTIAL", "NOT_ACHIEVED", "NOT_APPLICABLE"];

/**
 * What saving a goal draft sends: only the fields that differ from the saved draft, or null. Partial's codes are
 * cleared when its criteria are, because the judge offers Partial only with criteria. The silence limit is never sent.
 */
export function goalPatch(saved: GoalFields, e: GoalFields): GoalPatch | null {
  const patch: GoalPatch = {};
  for (const f of ["name", "description", "success_criteria", "partial_success", "not_applicable_when", "required_outputs"] as const)
    if (!same(saved[f], e[f])) (patch as Record<string, unknown>)[f] = e[f];
  const codes = { ...e.reason_codes, ...(e.partial_success.length ? {} : { PARTIAL: [] }) };
  const changedCodes = OUTCOMES.filter((o) => !same(saved.reason_codes[o] ?? [], codes[o] ?? []));
  if (changedCodes.length) patch.reason_codes = Object.fromEntries(changedCodes.map((o) => [o, codes[o] ?? []]));
  const sc: NonNullable<GoalPatch["system_checks"]> = {};
  if (!same(saved.system_checks.required_variables, e.system_checks.required_variables)) sc.required_variables = e.system_checks.required_variables;
  if (!same(saved.system_checks.flow_steps ?? [], e.system_checks.flow_steps ?? [])) sc.flow_steps = e.system_checks.flow_steps;
  if (Object.keys(sc).length) patch.system_checks = sc;
  return Object.keys(patch).length ? patch : null;
}

/** One difference between two versions, as the API returns it. */
export type ConfigChange = { field: string; before: unknown; after: unknown };
/** Names used to describe changes: metric keys and condition codes to their labels. */
export type ChangeNames = { metrics?: Record<string, string>; conditions?: Record<string, string> };

const OUTCOME_LABEL: Record<string, string> = { ACHIEVED: "Achieved", PARTIAL: "Partial", NOT_ACHIEVED: "Not achieved", NOT_APPLICABLE: "Not applicable" };
const FIELD: Record<string, string> = {
  name: "Name",
  description: "Description",
  success_criteria: "Success when",
  partial_success: "Partial success when",
  not_applicable_when: "Not applicable when",
  required_outputs: "Required outputs",
  pass_threshold: "Pass threshold",
  copied_from: "Copied from",
  "system_checks.required_variables": "Required variables",
  "system_checks.flow_steps": "Flow steps",
  "system_checks.silence_limit_s": "Silence limit",
};
const METRIC_FIELD: Record<string, string> = {
  name: "name",
  description: "description",
  weight: "weight",
  applicability: "N/A when",
  auto_fail: "auto-fail",
  "rubric.checks": "rubric",
  "rubric.anchors.0": "0-point example",
  "rubric.anchors.5": "5-point example",
  "rubric.anchors.10": "10-point example",
  method: "method",
  scale: "scale",
};
const CONDITION_FIELD: Record<string, string> = { enabled: "on/off", severity: "severity", metric_key: "metric it zeroes" };
const capital = (s: string) => s[0]!.toUpperCase() + s.slice(1);

function show(value: unknown, field: string): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "none";
  if (typeof value === "object") {
    const c = value as { enabled?: boolean; severity?: string };
    return c.severity ? `${c.enabled === false ? "Off, " : ""}${capital(c.severity)}` : JSON.stringify(value);
  }
  if (field.endsWith(".severity") && typeof value === "string") return capital(value);
  if (field.endsWith("silence_limit_s")) return `${value} s`;
  return String(value);
}

/** A change in words: what moved, and its value before and after. */
export function describeChange(c: ConfigChange, names: ChangeNames = {}): { label: string; before: string; after: string } {
  const parts = c.field.split(".");
  let label = FIELD[c.field] ?? c.field;
  if (parts[0] === "metric" || parts[0] === "condition") {
    const name = (parts[0] === "metric" ? names.metrics : names.conditions)?.[parts[1]!] ?? parts[1]!;
    const rest = parts.slice(2).join(".");
    const fields = parts[0] === "metric" ? METRIC_FIELD : CONDITION_FIELD;
    label = rest ? `${name} ${fields[rest] ?? rest}` : c.before === null ? `${name} added` : `${name} removed`;
  } else if (parts[0] === "reason_codes") {
    label = `${OUTCOME_LABEL[parts[1]!] ?? parts[1]} reason codes`;
  }
  return { label, before: show(c.before, c.field), after: show(c.after, c.field) };
}

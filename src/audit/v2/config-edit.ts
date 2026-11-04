import { CODE_PATTERN, NEEDS_DATA } from "./conditions";
import type { BusinessOutcome, GoalConfig, MetricRubric, ScorecardVersion, Severity } from "./config";
import { validateWeights } from "./score";

/**
 * Edits an admin can make to a scorecard or goal config draft (P1-18), checked and applied without I/O. A draft may be
 * incomplete while it is being written; `validateScorecard` / `validateGoalConfig` decide whether it can be published.
 * What can't be changed here, and why:
 * - a metric's method, scale, requirements and params: the engine decides how each metric is scored (the judge scores
 *   0–10; rule metrics are computed by code), so a change would silently score it differently;
 * - adding or removing metrics: the engine scores the known keys only;
 * - removing a condition from a scorecard: switch it off instead. A library condition the scorecard doesn't have yet can
 *   be attached; it starts as Minor unless the edit says otherwise (PRD §4.5: new conditions flag only at first);
 * - the silence limit: S2 has no timing data to apply it to yet (P0-5).
 */

export type MetricPatch = {
  key: string;
  name?: string;
  description?: string;
  rubric?: { checks?: string; anchors?: Partial<MetricRubric["anchors"]> };
  applicability?: string;
  auto_fail?: boolean;
  weight?: number;
};
export type ConditionPatch = { code: string; enabled?: boolean; severity?: Severity; metric_key?: string | null };
export type ScorecardPatch = { pass_threshold?: number; metrics?: MetricPatch[]; conditions?: ConditionPatch[] };

export type GoalPatch = Partial<
  Pick<GoalConfig, "name" | "description" | "success_criteria" | "partial_success" | "not_applicable_when" | "required_outputs">
> & {
  reason_codes?: Partial<Record<BusinessOutcome, string[]>>;
  system_checks?: { required_variables?: string[]; flow_steps?: string[] | null };
};

export type Edited<T> = { value: T; errors: [] } | { value: null; errors: string[] };

const METRIC_PATCH_FIELDS = new Set(["key", "name", "description", "rubric", "applicability", "auto_fail", "weight"]);
const LOCKED_METRIC_FIELDS: Record<string, string> = {
  method: "the method",
  scale: "the scale",
  requires: "what a metric needs",
  params: "a metric's params",
};
const oneDecimal = (n: number) => Math.abs(n * 10 - Math.round(n * 10)) < 1e-9;

/**
 * Applies a patch to a scorecard draft: the new draft, or every reason it can't be applied. `library` is the codes in
 * the shared failure-condition library, which a patch may attach to the draft.
 */
export function applyScorecardEdit<S extends Pick<ScorecardVersion, "pass_threshold" | "metrics" | "conditions">>(
  draft: S,
  patch: ScorecardPatch,
  library: string[] = [],
): Edited<S> {
  const errors: string[] = [];
  const keys = draft.metrics.map((m) => m.key);

  if (patch.pass_threshold !== undefined) {
    const t = patch.pass_threshold;
    if (!(typeof t === "number" && t >= 0 && t <= 100 && oneDecimal(t))) errors.push("the pass threshold must be 0–100 with at most one decimal");
  }

  const metrics = draft.metrics.map((m) => ({ ...m, rubric: { ...m.rubric, anchors: { ...m.rubric.anchors } } }));
  for (const p of patch.metrics ?? []) {
    const m = metrics.find((x) => x.key === p.key);
    if (!m) {
      errors.push(`no metric ${p.key} on this scorecard (metrics can't be added here)`);
      continue;
    }
    for (const field of Object.keys(p)) {
      if (LOCKED_METRIC_FIELDS[field])
        errors.push(`${p.key}: ${LOCKED_METRIC_FIELDS[field]} can't be changed here; the engine decides how a metric is scored`);
      else if (!METRIC_PATCH_FIELDS.has(field)) errors.push(`${p.key}: unknown field ${field}`);
    }
    if (p.name !== undefined) {
      if (!p.name.trim()) errors.push(`${p.key}: the name can't be empty`);
      m.name = p.name.trim();
    }
    if (p.description !== undefined) m.description = p.description.trim();
    if (p.applicability !== undefined) m.applicability = p.applicability.trim();
    if (p.auto_fail !== undefined) m.auto_fail = p.auto_fail;
    if (p.weight !== undefined) m.weight = p.weight;
    if (p.rubric?.checks !== undefined) {
      if (!p.rubric.checks.trim()) errors.push(`${p.key}: the rubric needs a description of what is checked`);
      m.rubric.checks = p.rubric.checks.trim();
    }
    for (const [anchor, text] of Object.entries(p.rubric?.anchors ?? {})) {
      if (!["0", "5", "10"].includes(anchor)) errors.push(`${p.key}: unknown rubric anchor ${anchor}`);
      else if (!text?.trim()) errors.push(`${p.key}: the rubric's ${anchor}-point example can't be empty`);
      else m.rubric.anchors[anchor as "0" | "5" | "10"] = text.trim();
    }
  }
  if (patch.metrics?.some((p) => p.weight !== undefined))
    errors.push(...validateWeights(Object.fromEntries(metrics.map((m) => [m.key, m.weight])), keys));

  const conditions = draft.conditions.map((c) => ({ ...c }));
  for (const p of patch.conditions ?? []) {
    let c = conditions.find((x) => x.condition_code === p.code);
    if (!c) {
      if (!library.includes(p.code)) {
        errors.push(`no condition ${p.code} in the library; add it on the failure conditions page`);
        continue;
      }
      // Attached from the library: off by default when its data doesn't exist yet, Minor unless said otherwise.
      c = { condition_code: p.code, enabled: false, severity: "minor", metric_key: null };
      conditions.push(c);
      if (p.enabled === undefined && !NEEDS_DATA[p.code]) c.enabled = true;
    }
    if (p.enabled === true && !c.enabled && NEEDS_DATA[p.code]) errors.push(`${p.code} can't be switched on: ${NEEDS_DATA[p.code]}`);
    if (p.enabled !== undefined) c.enabled = p.enabled;
    if (p.severity !== undefined) c.severity = p.severity;
    if (p.metric_key !== undefined) {
      if (p.metric_key !== null && !keys.includes(p.metric_key)) errors.push(`${p.code}: no metric ${p.metric_key} on this scorecard`);
      c.metric_key = p.metric_key;
    }
    if (c.severity === "major" && !c.metric_key) errors.push(`${p.code}: a Major condition needs the metric it sets to 0`);
  }

  if (errors.length) return { value: null, errors };
  return { value: { ...draft, pass_threshold: patch.pass_threshold ?? draft.pass_threshold, metrics, conditions }, errors: [] };
}

const OUTCOMES: BusinessOutcome[] = ["ACHIEVED", "PARTIAL", "NOT_ACHIEVED", "NOT_APPLICABLE"];
/** A call variable or saved output key, e.g. `demo_datetime` or `outcome.notice_period`. */
const VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_.]{0,63}$/;
/** Trims each item and drops empty ones, so a blank row left in a list editor isn't saved. */
const cleanList = (items: string[]) => items.map((i) => i.trim()).filter(Boolean);
const twice = (list: string[]) => [...new Set(list.filter((x, i) => list.indexOf(x) !== i))];

/** Applies a patch to a goal config draft: the new draft, or every reason it can't be applied. */
export function applyGoalEdit(draft: GoalConfig, patch: GoalPatch): Edited<GoalConfig> {
  const errors: string[] = [];
  const next: GoalConfig = { ...draft, reason_codes: { ...draft.reason_codes }, system_checks: { ...draft.system_checks } };

  if (patch.name !== undefined) {
    if (!patch.name.trim()) errors.push("the goal needs a name");
    next.name = patch.name.trim();
  }
  if (patch.description !== undefined) next.description = patch.description.trim();
  for (const f of ["success_criteria", "partial_success", "not_applicable_when"] as const) {
    const items = patch[f];
    if (items !== undefined) next[f] = cleanList(items);
  }

  const variables = (label: string, items: string[]) => {
    const list = cleanList(items);
    for (const v of list) if (!VARIABLE_PATTERN.test(v)) errors.push(`${label}: ${v} isn't a variable name (letters, digits, _ and .)`);
    for (const v of twice(list)) errors.push(`${label}: ${v} is listed twice`);
    return list;
  };
  if (patch.required_outputs !== undefined) next.required_outputs = variables("required outputs", patch.required_outputs);
  if (patch.system_checks?.required_variables !== undefined)
    next.system_checks.required_variables = variables("required variables", patch.system_checks.required_variables);
  if (patch.system_checks?.flow_steps !== undefined) {
    const steps = cleanList(patch.system_checks.flow_steps ?? []);
    next.system_checks.flow_steps = steps.length ? steps : null;
  }

  for (const [outcome, codes] of Object.entries(patch.reason_codes ?? {})) {
    if (!OUTCOMES.includes(outcome as BusinessOutcome)) {
      errors.push(`unknown outcome ${outcome}`);
      continue;
    }
    const list = cleanList(codes ?? []).map((c) => c.toUpperCase());
    for (const c of list) if (!CODE_PATTERN.test(c)) errors.push(`${outcome}: reason code ${c} must be 3–64 capital letters, digits or _`);
    for (const c of twice(list)) errors.push(`${outcome}: reason code ${c} is listed twice`);
    if (list.length) next.reason_codes[outcome as BusinessOutcome] = list;
    else delete next.reason_codes[outcome as BusinessOutcome];
  }

  return errors.length ? { value: null, errors } : { value: next, errors: [] };
}

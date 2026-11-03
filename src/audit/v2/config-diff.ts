import type { GoalConfig, Metric, ScorecardCondition, ScorecardVersion } from "./config";

/** One thing that differs between two versions of a scorecard or goal config. `before` is null for something added. */
export type ConfigChange = { field: string; before: unknown; after: unknown };

/** Key-order-independent equality for the JSON values config fields hold. */
const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
        )
      : v;
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a ?? null)) === JSON.stringify(canonical(b ?? null));

function compare(changes: ConfigChange[], field: string, before: unknown, after: unknown) {
  if (!same(before, after)) changes.push({ field, before: before ?? null, after: after ?? null });
}

/** The metric fields an admin sees, after its name and rubric; `id` and `position` are storage details. */
const METRIC_FIELDS = ["description", "applicability", "method", "weight", "scale", "auto_fail", "evidence_required", "requires", "params"] as const;

function diffMetric(changes: ConfigChange[], before: Metric, after: Metric) {
  const at = `metric.${after.key}`;
  compare(changes, `${at}.name`, before.name, after.name);
  compare(changes, `${at}.rubric.checks`, before.rubric.checks, after.rubric.checks);
  for (const a of ["0", "5", "10"] as const) compare(changes, `${at}.rubric.anchors.${a}`, before.rubric.anchors[a], after.rubric.anchors[a]);
  for (const f of METRIC_FIELDS) compare(changes, `${at}.${f}`, before[f], after[f]);
}

const CONDITION_FIELDS = ["enabled", "severity", "metric_key"] as const;
const conditionValue = (c: ScorecardCondition) => ({ enabled: c.enabled, severity: c.severity, metric_key: c.metric_key });

/**
 * What changed from one scorecard version to another, in a readable field path per change: `pass_threshold`,
 * `metric.<key>.weight`, `metric.<key>.rubric.anchors.5`, `condition.<code>.severity`; a metric or condition added or
 * removed is one change on `metric.<key>` / `condition.<code>`. Used for a draft's pending changes, the change log and
 * the version history. Pure.
 */
export function diffScorecard(
  before: Pick<ScorecardVersion, "name" | "pass_threshold" | "metrics" | "conditions">,
  after: Pick<ScorecardVersion, "name" | "pass_threshold" | "metrics" | "conditions">,
): ConfigChange[] {
  const changes: ConfigChange[] = [];
  compare(changes, "name", before.name, after.name);
  compare(changes, "pass_threshold", before.pass_threshold, after.pass_threshold);
  for (const m of after.metrics) {
    const old = before.metrics.find((b) => b.key === m.key);
    if (old) diffMetric(changes, old, m);
    else changes.push({ field: `metric.${m.key}`, before: null, after: m.name });
  }
  for (const m of before.metrics)
    if (!after.metrics.some((a) => a.key === m.key)) changes.push({ field: `metric.${m.key}`, before: m.name, after: null });
  for (const c of after.conditions) {
    const old = before.conditions.find((b) => b.condition_code === c.condition_code);
    if (!old) changes.push({ field: `condition.${c.condition_code}`, before: null, after: conditionValue(c) });
    else for (const f of CONDITION_FIELDS) compare(changes, `condition.${c.condition_code}.${f}`, old[f], c[f]);
  }
  for (const c of before.conditions)
    if (!after.conditions.some((a) => a.condition_code === c.condition_code))
      changes.push({ field: `condition.${c.condition_code}`, before: conditionValue(c), after: null });
  return changes;
}

const GOAL_FIELDS = ["name", "description", "success_criteria", "partial_success", "not_applicable_when", "required_outputs"] as const;
const OUTCOMES = ["ACHIEVED", "PARTIAL", "NOT_ACHIEVED", "NOT_APPLICABLE"] as const;

/**
 * What changed from one goal config version to another: the business goal fields, `reason_codes.<OUTCOME>`, and
 * `system_checks.<setting>`. Pure.
 */
export function diffGoal(before: GoalConfig, after: GoalConfig): ConfigChange[] {
  const changes: ConfigChange[] = [];
  for (const f of GOAL_FIELDS) compare(changes, f, before[f], after[f]);
  for (const o of OUTCOMES) compare(changes, `reason_codes.${o}`, before.reason_codes[o] ?? [], after.reason_codes[o] ?? []);
  for (const s of ["required_variables", "flow_steps", "silence_limit_s"] as const)
    compare(changes, `system_checks.${s}`, before.system_checks[s], after.system_checks[s]);
  return changes;
}

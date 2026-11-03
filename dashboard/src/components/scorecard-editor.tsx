import { rebalanceWeights } from "@engine/rebalance";
import { Lock, LockOpen } from "lucide-react";
import { type ReactNode, createContext, use, useId, useMemo, useState } from "react";
import type { ConfigMetric, ScorecardAdmin, ScorecardCondition, ScorecardPatch, ScorecardVersion, Severity } from "../api";
import { SeverityBadge } from "../pages/Conditions";
import { Input, Segmented, Select, Slider, Switch, Textarea } from "./ui";

/**
 * The scorecard editor as compound components (vercel-composition-patterns): one context holds the scorecard being
 * shown (`state`), what can be done to it (`actions`) and how to show it (`meta`). Two providers implement it:
 * `ScorecardEditor.Published` (read-only, the live version) and `ScorecardEditor.Draft` (local edits of the draft,
 * saved with one PATCH). The parts (`MetricEditor.*`, `ConditionEditor.*`) read the context, so none of them takes a
 * mode or a pile of flags.
 */

type Edits = Pick<ScorecardVersion, "pass_threshold" | "metrics" | "conditions">;
type MetricEdit = Partial<Pick<ConfigMetric, "name" | "description" | "applicability" | "auto_fail">> & {
  rubric?: { checks?: string; anchors?: Partial<ConfigMetric["rubric"]["anchors"]> };
};

type EditorContextValue = {
  state: { scorecard: Edits; locked: string[] };
  actions: {
    setThreshold: (value: number) => void;
    setWeight: (key: string, value: number) => void;
    setLocked: (key: string, locked: boolean) => void;
    updateMetric: (key: string, edit: MetricEdit) => void;
    updateCondition: (code: string, edit: Partial<Omit<ScorecardCondition, "condition_code">>) => void;
  };
  meta: {
    /** "view" for the live version, "edit" for a draft. */
    mode: "view" | "edit";
    /** The live version, to mark what a draft changes. */
    live: ScorecardVersion;
    library: ScorecardAdmin["library"];
  };
};

const EditorContext = createContext<EditorContextValue | null>(null);
const useEditor = () => {
  const ctx = use(EditorContext);
  if (!ctx) throw new Error("ScorecardEditor parts must be inside ScorecardEditor.Published or .Draft");
  return ctx;
};

const noop = () => {};

function Published({ admin, children }: { admin: ScorecardAdmin; children: ReactNode }) {
  const value: EditorContextValue = {
    state: { scorecard: admin.published, locked: [] },
    actions: { setThreshold: noop, setWeight: noop, setLocked: noop, updateMetric: noop, updateCondition: noop },
    meta: { mode: "view", live: admin.published, library: admin.library },
  };
  return <EditorContext value={value}>{children}</EditorContext>;
}

/** The local edits of a draft, and what saving them sends. Lifted out of the provider so the draft bar can save. */
export function useDraftEdits(draft: ScorecardVersion) {
  const [edits, setEdits] = useState<Edits>(() => ({ pass_threshold: draft.pass_threshold, metrics: draft.metrics, conditions: draft.conditions }));
  const [locked, setLockedKeys] = useState<string[]>([]);
  const patch = useMemo(() => patchFor(draft, edits), [draft, edits]);
  const actions: EditorContextValue["actions"] = {
    setThreshold: (pass_threshold) => setEdits((e) => ({ ...e, pass_threshold })),
    setWeight: (key, value) =>
      setEdits((e) => {
        if (locked.includes(key)) return e;
        const next = rebalanceWeights(
          e.metrics.map((m) => ({ key: m.key, weight: m.weight })),
          locked,
          key,
          value,
        );
        return { ...e, metrics: e.metrics.map((m, i) => ({ ...m, weight: next[i]!.weight })) };
      }),
    setLocked: (key, on) => setLockedKeys((l) => (on ? [...l, key] : l.filter((k) => k !== key))),
    updateMetric: (key, edit) =>
      setEdits((e) => ({
        ...e,
        metrics: e.metrics.map((m) =>
          m.key === key
            ? { ...m, ...edit, rubric: { ...m.rubric, ...edit.rubric, anchors: { ...m.rubric.anchors, ...edit.rubric?.anchors } } }
            : m,
        ),
      })),
    updateCondition: (code, edit) =>
      setEdits((e) => ({ ...e, conditions: e.conditions.map((c) => (c.condition_code === code ? { ...c, ...edit } : c)) })),
  };
  return {
    edits,
    locked,
    actions,
    patch,
    unsaved: patch !== null,
    reset: () => {
      setEdits({ pass_threshold: draft.pass_threshold, metrics: draft.metrics, conditions: draft.conditions });
      setLockedKeys([]);
    },
  };
}
export type DraftEdits = ReturnType<typeof useDraftEdits>;

/** Only what differs from the saved draft; null when nothing does. */
function patchFor(saved: ScorecardVersion, e: Edits): ScorecardPatch | null {
  const patch: ScorecardPatch = {};
  if (e.pass_threshold !== saved.pass_threshold) patch.pass_threshold = e.pass_threshold;
  const metrics: NonNullable<ScorecardPatch["metrics"]> = [];
  for (const m of e.metrics) {
    const s = saved.metrics.find((x) => x.key === m.key)!;
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
      const s = saved.conditions.find((x) => x.condition_code === c.condition_code)!;
      return s.enabled !== c.enabled || s.severity !== c.severity || s.metric_key !== c.metric_key;
    })
    .map((c) => ({ code: c.condition_code, enabled: c.enabled, severity: c.severity, metric_key: c.metric_key }));
  if (conditions.length) patch.conditions = conditions;
  return Object.keys(patch).length ? patch : null;
}

function Draft({ admin, draft, children }: { admin: ScorecardAdmin; draft: DraftEdits; children: ReactNode }) {
  const value: EditorContextValue = {
    state: { scorecard: draft.edits, locked: draft.locked },
    actions: draft.actions,
    meta: { mode: "edit", live: admin.published, library: admin.library },
  };
  return <EditorContext value={value}>{children}</EditorContext>;
}

/** A 2px accent rule on the left of anything a draft changes, with a screen-reader word. */
function Changed({ changed, children, className = "" }: { changed: boolean; children: ReactNode; className?: string }) {
  return (
    <div className={`relative ${className}`}>
      {changed && <span className="absolute inset-y-1 -left-3 w-0.5 rounded-full bg-accent" aria-hidden />}
      {changed && <span className="sr-only">Changed in this draft.</span>}
      {children}
    </div>
  );
}

// ---- Pass threshold ---------------------------------------------------------------------------------------------

function Threshold() {
  const { state, actions, meta } = useEditor();
  const id = useId();
  const value = state.scorecard.pass_threshold;
  const was = meta.live.pass_threshold;
  if (meta.mode === "view")
    return (
      <p className="text-sm text-ink">
        A call passes at <span className="font-semibold tabular">{value}</span> or above, with no auto-fail metric at 0 and no Critical
        condition.
      </p>
    );
  return (
    <Changed changed={value !== was}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-ink">
        <label htmlFor={id}>A call passes at</label>
        <Input
          id={id}
          type="number"
          min={0}
          max={100}
          step={0.5}
          className="w-20 tabular"
          value={value}
          onChange={(e) => e.target.value !== "" && actions.setThreshold(Number(e.target.value))}
        />
        <span>or above, with no auto-fail metric at 0 and no Critical condition.</span>
        {value !== was && <span className="text-xs text-muted tabular">was {was}</span>}
      </div>
    </Changed>
  );
}

// ---- Metrics -----------------------------------------------------------------------------------------------------

const METHOD: Record<ConfigMetric["method"], string> = { llm: "Judged by the LLM", rule: "Counted by rules", hybrid: "Rules + LLM", audio: "From audio" };
const NEEDS: Record<ConfigMetric["requires"][number], string> = { audio: "audio", timestamps: "call timing", tool_calls: "tool-call logs" };

const editableFields = (m: ConfigMetric) => JSON.stringify([m.name, m.description, m.rubric, m.applicability, m.auto_fail, m.weight]);

type MetricContextValue = { metric: ConfigMetric; live: ConfigMetric | undefined };
const MetricContext = createContext<MetricContextValue | null>(null);
const useMetric = () => use(MetricContext)!;

function MetricRoot({ metricKey, children }: { metricKey: string; children: ReactNode }) {
  const { state, meta } = useEditor();
  const metric = state.scorecard.metrics.find((m) => m.key === metricKey)!;
  const live = meta.live.metrics.find((m) => m.key === metricKey);
  const changed = live !== undefined && editableFields(live) !== editableFields(metric);
  return (
    <MetricContext value={{ metric, live }}>
      <li className="py-3 first:pt-0 last:pb-0">
        <Changed changed={changed}>{children}</Changed>
      </li>
    </MetricContext>
  );
}

function MetricHeader() {
  const { metric } = useMetric();
  return (
    <div className="min-w-0">
      <div className="text-sm font-medium text-ink">{metric.name}</div>
      <div className="text-xs text-muted">
        {METHOD[metric.method]} · 0–{metric.scale}
        {metric.requires.length > 0 && ` · N/A on every call until ${metric.requires.map((r) => NEEDS[r]).join(" and ")} exist`}
        {metric.auto_fail && " · auto-fail at 0"}
      </div>
    </div>
  );
}

function MetricWeight() {
  const { state, actions, meta } = useEditor();
  const { metric, live } = useMetric();
  const [typed, setTyped] = useState<string | null>(null);
  const locked = state.locked.includes(metric.key);
  const changed = live !== undefined && live.weight !== metric.weight;
  if (meta.mode === "view")
    return (
      <div className="flex items-center gap-3">
        <div className="h-1 w-full rounded-full bg-accent-track" aria-hidden>
          <div className="h-1 rounded-full bg-accent" style={{ width: `${metric.weight}%` }} />
        </div>
        <span className="w-12 text-right text-sm font-medium text-ink tabular">{metric.weight.toFixed(1)}</span>
      </div>
    );
  const commit = () => {
    if (typed !== null && typed.trim() !== "" && !Number.isNaN(Number(typed))) actions.setWeight(metric.key, Number(typed));
    setTyped(null);
  };
  return (
    <div>
      <div className="flex items-center gap-2">
        <Slider
          aria-label={`${metric.name} weight`}
          value={metric.weight}
          step={0.5}
          disabled={locked}
          onChange={(e) => actions.setWeight(metric.key, Number(e.target.value))}
        />
        <Input
          aria-label={`${metric.name} weight, exact`}
          className="w-[4.5rem] flex-none text-right tabular"
          inputMode="decimal"
          disabled={locked}
          value={typed ?? metric.weight.toFixed(1)}
          onChange={(e) => setTyped(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && commit()}
        />
        <button
          type="button"
          className="btn btn-ghost btn-compact flex-none px-2"
          aria-pressed={locked}
          aria-label={`Lock ${metric.name} weight`}
          title={locked ? "Locked: other sliders won't move it" : "Lock this weight while you move the others"}
          onClick={() => actions.setLocked(metric.key, !locked)}
        >
          {locked ? <Lock size={15} aria-hidden /> : <LockOpen size={15} aria-hidden className="text-muted" />}
        </button>
      </div>
      {changed && <div className="mt-0.5 text-right text-xs text-muted tabular">was {live!.weight.toFixed(1)}</div>}
    </div>
  );
}

/** The rubric, applicability and auto-fail, folded away under the row. */
function MetricDetails({ children }: { children: ReactNode }) {
  const { meta } = useEditor();
  const { metric, live } = useMetric();
  const changed =
    live !== undefined &&
    (live.rubric.checks !== metric.rubric.checks ||
      (["0", "5", "10"] as const).some((a) => live.rubric.anchors[a] !== metric.rubric.anchors[a]) ||
      live.applicability !== metric.applicability ||
      live.auto_fail !== metric.auto_fail);
  return (
    <details className="group mt-2">
      <summary className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-ink-2 hover:text-ink">
        {meta.mode === "edit" ? "Edit rubric and rules" : "Rubric and rules"}
        {changed && <span className="rounded bg-accent-track px-1 text-[11px] font-medium text-ink">changed</span>}
      </summary>
      <div className="mt-3 flex flex-col gap-3 rounded-lg bg-sunken p-3">{children}</div>
    </details>
  );
}

function TextField({ label, value, was, onChange, rows = 2 }: { label: string; value: string; was: string | undefined; onChange: (v: string) => void; rows?: number }) {
  const { meta } = useEditor();
  const id = useId();
  if (meta.mode === "view")
    return (
      <div className="flex flex-col gap-0.5">
        <span className="text-xs text-muted">{label}</span>
        <p className="text-sm whitespace-pre-line text-ink">{value || "—"}</p>
      </div>
    );
  return (
    <Changed changed={was !== undefined && was !== value}>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={id} className="text-xs font-medium text-ink">
          {label}
        </label>
        <Textarea id={id} rows={rows} value={value} onChange={(e) => onChange(e.target.value)} />
      </div>
    </Changed>
  );
}

function MetricRubric() {
  const { actions } = useEditor();
  const { metric, live } = useMetric();
  return (
    <>
      <TextField
        label="What is checked"
        rows={3}
        value={metric.rubric.checks}
        was={live?.rubric.checks}
        onChange={(checks) => actions.updateMetric(metric.key, { rubric: { checks } })}
      />
      <div className="grid gap-3 md:grid-cols-3">
        {(["10", "5", "0"] as const).map((a) => (
          <TextField
            key={a}
            label={`${a} points looks like`}
            rows={3}
            value={metric.rubric.anchors[a]}
            was={live?.rubric.anchors[a]}
            onChange={(text) => actions.updateMetric(metric.key, { rubric: { anchors: { [a]: text } } })}
          />
        ))}
      </div>
    </>
  );
}

function MetricApplicability() {
  const { actions } = useEditor();
  const { metric, live } = useMetric();
  return (
    <TextField
      label="Not applicable when"
      value={metric.applicability}
      was={live?.applicability}
      onChange={(applicability) => actions.updateMetric(metric.key, { applicability })}
    />
  );
}

function MetricAutoFail() {
  const { actions, meta } = useEditor();
  const { metric, live } = useMetric();
  const labelId = useId();
  return (
    <Changed changed={live !== undefined && live.auto_fail !== metric.auto_fail}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div id={labelId} className="text-xs font-medium text-ink">
            Auto-fail
          </div>
          <p className="text-xs text-ink-2">A 0 on this metric fails the call, whatever the total.</p>
        </div>
        {meta.mode === "view" ? (
          <span className="text-sm text-ink">{metric.auto_fail ? "On" : "Off"}</span>
        ) : (
          <Switch aria-labelledby={labelId} checked={metric.auto_fail} onChange={(auto_fail) => actions.updateMetric(metric.key, { auto_fail })} />
        )}
      </div>
    </Changed>
  );
}

export const MetricEditor = {
  Root: MetricRoot,
  Header: MetricHeader,
  Weight: MetricWeight,
  Details: MetricDetails,
  Rubric: MetricRubric,
  Applicability: MetricApplicability,
  AutoFail: MetricAutoFail,
};

/** The weight total; always 100.0, because moving one slider rebalances the others. */
function WeightTotal() {
  const { state } = useEditor();
  const total = state.scorecard.metrics.reduce((sum, m) => sum + Math.round(m.weight * 10), 0) / 10;
  return <span className="text-xs text-muted tabular">Total {total.toFixed(1)}</span>;
}

// ---- Conditions --------------------------------------------------------------------------------------------------

type ConditionContextValue = { condition: ScorecardCondition; live: ScorecardCondition | undefined; info: ScorecardAdmin["library"][number] | undefined };
const ConditionContext = createContext<ConditionContextValue | null>(null);
const useCondition = () => use(ConditionContext)!;

function ConditionRoot({ code, children }: { code: string; children: ReactNode }) {
  const { state, meta } = useEditor();
  const condition = state.scorecard.conditions.find((c) => c.condition_code === code)!;
  const live = meta.live.conditions.find((c) => c.condition_code === code);
  const info = meta.library.find((l) => l.code === code);
  const changed = live !== undefined && (live.enabled !== condition.enabled || live.severity !== condition.severity || live.metric_key !== condition.metric_key);
  return (
    <ConditionContext value={{ condition, live, info }}>
      <li className="py-3 first:pt-0 last:pb-0">
        <Changed changed={changed} className="grid gap-x-4 gap-y-2 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
          {children}
        </Changed>
      </li>
    </ConditionContext>
  );
}

function ConditionLabel() {
  const { condition, info } = useCondition();
  return (
    <div className="min-w-0">
      <div className="text-sm font-medium text-ink" title={info?.definition}>
        {info?.label ?? condition.condition_code}
      </div>
      <div className="text-xs text-muted">
        <code>{condition.condition_code}</code>
        {info?.detection === "rule" && " · rule"}
      </div>
      {info?.needs_data && <p className="mt-0.5 text-xs text-ink-2">{info.needs_data}</p>}
    </div>
  );
}

/** The controls on the right of a condition row: on/off, severity, and the metric a Major flag zeroes. */
function ConditionControls({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-3">{children}</div>;
}

function ConditionEnabled() {
  const { actions, meta } = useEditor();
  const { condition, info } = useCondition();
  const label = info?.label ?? condition.condition_code;
  if (meta.mode === "view") return condition.enabled ? null : <span className="text-xs text-muted">Off</span>;
  // A condition whose data doesn't exist yet can be switched off but not on.
  const locked = Boolean(info?.needs_data) && !condition.enabled;
  return (
    <Switch
      aria-label={`${label} on`}
      checked={condition.enabled}
      disabled={locked}
      title={locked ? info!.needs_data! : undefined}
      onChange={(enabled) => actions.updateCondition(condition.condition_code, { enabled })}
    />
  );
}

const SEVERITIES: [Severity, string][] = [
  ["critical", "Critical"],
  ["major", "Major"],
  ["minor", "Minor"],
];

function ConditionSeverity() {
  const { actions, meta, state } = useEditor();
  const { condition, info } = useCondition();
  if (meta.mode === "view") return condition.enabled ? <SeverityBadge severity={condition.severity} /> : null;
  return (
    <Segmented<Severity>
      legend={`${info?.label ?? condition.condition_code} severity`}
      value={condition.severity}
      options={SEVERITIES}
      onChange={(severity) =>
        actions.updateCondition(condition.condition_code, {
          severity,
          // Major needs a metric to zero: start from the one it already names, else the first.
          metric_key: severity === "major" ? (condition.metric_key ?? state.scorecard.metrics[0]!.key) : condition.metric_key,
        })
      }
    />
  );
}

function ConditionMetric() {
  const { actions, meta, state } = useEditor();
  const { condition } = useCondition();
  if (condition.severity !== "major") return null;
  const metrics = state.scorecard.metrics;
  if (meta.mode === "view")
    return <span className="text-xs text-muted">zeroes {metrics.find((m) => m.key === condition.metric_key)?.name ?? "—"}</span>;
  return (
    <Select
      label="Sets to 0"
      value={condition.metric_key ?? ""}
      onChange={(metric_key) => actions.updateCondition(condition.condition_code, { metric_key })}
      options={metrics.map((m) => [m.key, m.name])}
    />
  );
}

export const ConditionEditor = {
  Root: ConditionRoot,
  Label: ConditionLabel,
  Controls: ConditionControls,
  Enabled: ConditionEnabled,
  Severity: ConditionSeverity,
  Metric: ConditionMetric,
};

export const ScorecardEditor = { Published, Draft, Threshold, WeightTotal };

/** The scorecard being shown (live or draft edits), for layouts that list its metrics and conditions. */
export const useScorecard = () => useEditor().state.scorecard;

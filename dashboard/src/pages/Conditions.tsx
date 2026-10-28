import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertOctagon, AlertTriangle, CircleDot, Trash2 } from "lucide-react";
import { useState } from "react";
import { conditionsApi, type LibraryCondition, type ScorecardConditions, type Severity } from "../api";
import { Badge, Card, Select } from "../components/ui";

const SEVERITY_LABEL: Record<Severity, string> = { critical: "Critical", major: "Major", minor: "Minor" };
const SEVERITY_HINT: Record<Severity, string> = {
  critical: "Fails the call whatever the score.",
  major: "Sets the linked metric to 0 for this call.",
  minor: "Flagged and counted; no effect on the score.",
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  if (severity === "critical") return <Badge tone="critical" icon={AlertOctagon}>Critical</Badge>;
  if (severity === "major") return <Badge tone="serious" icon={AlertTriangle}>Major</Badge>;
  return <Badge tone="neutral" icon={CircleDot}>Minor</Badge>;
}

/** Same as the server's `codeFromLabel`, so the code shown is the one that will be saved. */
const codeFromLabel = (label: string) =>
  label
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);

const field = "rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink focus:outline-2 focus:outline-accent";

function AddCondition({ scorecards }: { scorecards: ScorecardConditions[] }) {
  const qc = useQueryClient();
  const [label, setLabel] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [flagsWhen, setFlagsWhen] = useState("");
  const [doesNotCount, setDoesNotCount] = useState("");
  const [severity, setSeverity] = useState<Severity>("minor");
  const [metric, setMetric] = useState("");
  const [picked, setPicked] = useState<string[]>(() => scorecards.map((s) => s.scorecard_id));

  const add = useMutation({
    mutationFn: () =>
      conditionsApi.add({
        code: code ?? undefined,
        label,
        flags_when: flagsWhen,
        does_not_count: doesNotCount,
        severity,
        metric_key: metric || null,
        scorecards: picked,
      }),
    onSuccess: () => {
      setLabel("");
      setCode(null);
      setFlagsWhen("");
      setDoesNotCount("");
      setSeverity("minor");
      setMetric("");
      qc.invalidateQueries({ queryKey: ["conditions"] });
    },
  });

  const metrics = scorecards[0]?.metrics ?? [];
  const ready = label.trim().length >= 3 && flagsWhen.trim().length >= 10 && doesNotCount.trim().length >= 3 && picked.length > 0 && (severity !== "major" || metric);
  const shownCode = code ?? codeFromLabel(label);

  return (
    <Card title="Add a failure condition">
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) add.mutate();
        }}
      >
        <label className="flex flex-col gap-1 text-xs text-muted">
          Label
          <input className={field} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Asked for the OTP" maxLength={120} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Code
          <input
            className={`${field} font-mono`}
            value={shownCode}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="ASKED_FOR_THE_OTP"
            maxLength={64}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted sm:col-span-2">
          Flags when (a short definition for the judge)
          <textarea
            className={`${field} min-h-16`}
            value={flagsWhen}
            onChange={(e) => setFlagsWhen(e.target.value)}
            placeholder="The agent asked the other party to read out a one-time password"
            maxLength={1000}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted sm:col-span-2">
          Does not count when (keeps false flags down)
          <input
            className={field}
            value={doesNotCount}
            onChange={(e) => setDoesNotCount(e.target.value)}
            placeholder="the other party offered it without being asked"
            maxLength={500}
          />
        </label>
        <div className="flex flex-col gap-1">
          <Select
            label="Severity"
            value={severity}
            onChange={(v) => setSeverity(v as Severity)}
            options={(["minor", "major", "critical"] as Severity[]).map((s) => [s, SEVERITY_LABEL[s]])}
          />
          <span className="text-xs text-muted">
            {SEVERITY_HINT[severity]} {severity !== "minor" && "New conditions usually start as Minor for a week to check false flags."}
          </span>
        </div>
        {severity === "major" ? (
          <Select label="Metric it sets to 0" value={metric} onChange={setMetric} options={[["", "Pick a metric"], ...metrics.map((m) => [m.key, m.name] as [string, string])]} />
        ) : (
          <div />
        )}
        <fieldset className="flex flex-wrap items-center gap-3 text-sm text-ink sm:col-span-2">
          <legend className="mb-1 text-xs text-muted">Scorecards</legend>
          {scorecards.map((s) => (
            <label key={s.scorecard_id} className="inline-flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={picked.includes(s.scorecard_id)}
                onChange={(e) => setPicked((p) => (e.target.checked ? [...p, s.scorecard_id] : p.filter((x) => x !== s.scorecard_id)))}
              />
              {s.name}
            </label>
          ))}
        </fieldset>
        <div className="flex items-center gap-3 sm:col-span-2">
          <button disabled={!ready || add.isPending} className="h-8 rounded-md bg-accent px-3 text-sm font-medium text-white disabled:opacity-50">
            {add.isPending ? "Saving…" : "Save to drafts"}
          </button>
          <span className="text-xs text-muted">Saved conditions count only after you publish the scorecard below.</span>
        </div>
        {add.error && <p className="text-sm text-critical sm:col-span-2">{add.error.message}</p>}
      </form>
    </Card>
  );
}

function Drafts({ scorecards, library }: { scorecards: ScorecardConditions[]; library: LibraryCondition[] }) {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: ["conditions"] });
  const publish = useMutation({ mutationFn: conditionsApi.publish, onSuccess: done });
  const discard = useMutation({ mutationFn: conditionsApi.discard, onSuccess: done });
  const withDraft = scorecards.filter((s) => s.draft !== null);
  if (withDraft.length === 0) return null;
  const label = (code: string) => library.find((c) => c.code === code)?.label ?? code;

  return (
    <Card title="Waiting to publish">
      <div className="flex flex-col gap-4">
        {withDraft.map((s) => (
          <div key={s.scorecard_id} className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm text-ink">
                <span className="font-medium">{s.name}</span>{" "}
                <span className="text-muted">
                  v{s.published} → v{s.draft} · agents: {s.agents.join(", ") || "none"}
                </span>
              </div>
              <div className="flex gap-2">
                <button
                  className="h-8 rounded-md bg-accent px-3 text-sm font-medium text-white disabled:opacity-50"
                  disabled={publish.isPending || s.pending.length === 0}
                  onClick={() =>
                    window.confirm(`Publish ${s.name} v${s.draft}? Its agents (${s.agents.join(", ") || "none"}) move to it, and future v2 audits use it. A published version can't be changed.`) &&
                    publish.mutate(s.scorecard_id)
                  }
                >
                  Publish v{s.draft}
                </button>
                <button
                  className="h-8 rounded-md border border-line px-3 text-sm text-ink disabled:opacity-50"
                  disabled={discard.isPending}
                  onClick={() => window.confirm(`Discard the ${s.name} draft? The conditions stay in the library.`) && discard.mutate(s.scorecard_id)}
                >
                  Discard draft
                </button>
              </div>
            </div>
            {s.pending.length === 0 ? (
              <p className="text-xs text-muted">No condition changes in this draft.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {s.pending.map((c) => (
                  <li key={c.condition_code} className="flex flex-wrap items-center gap-2 text-sm text-ink">
                    <SeverityBadge severity={c.severity} />
                    {label(c.condition_code)} <code className="text-xs text-muted">{c.condition_code}</code>
                    {c.metric_key && <span className="text-xs text-muted">· zeroes {s.metrics.find((m) => m.key === c.metric_key)?.name}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
        {(publish.error || discard.error) && <p className="text-sm text-critical">{(publish.error ?? discard.error)!.message}</p>}
      </div>
    </Card>
  );
}

function Library({ conditions, scorecards }: { conditions: LibraryCondition[]; scorecards: ScorecardConditions[] }) {
  const qc = useQueryClient();
  const remove = useMutation({ mutationFn: conditionsApi.remove, onSuccess: () => qc.invalidateQueries({ queryKey: ["conditions"] }) });
  const onPublished = (code: string) => scorecards.some((s) => s.conditions.some((c) => c.condition_code === code));

  return (
    <Card title={`Library · ${conditions.length} conditions`}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-muted">
              <th className="py-2 pr-3 font-medium">Condition</th>
              <th className="py-2 pr-3 font-medium">Definition</th>
              {scorecards.map((s) => (
                <th key={s.scorecard_id} className="py-2 pr-3 font-medium whitespace-nowrap">
                  {s.name} v{s.published}
                </th>
              ))}
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {conditions.map((c) => (
              <tr key={c.code} className="border-b border-line align-top last:border-0">
                <td className="py-2 pr-3">
                  <div className="font-medium text-ink">{c.label}</div>
                  <code className="text-xs text-muted">{c.code}</code>
                  {c.detection === "rule" && <div className="text-xs text-muted">rule</div>}
                </td>
                <td className="max-w-xl py-2 pr-3 text-ink">{c.definition}</td>
                {scorecards.map((s) => {
                  const on = s.conditions.find((x) => x.condition_code === c.code);
                  return (
                    <td key={s.scorecard_id} className="py-2 pr-3 whitespace-nowrap">
                      {!on ? <span className="text-muted">—</span> : on.enabled ? <SeverityBadge severity={on.severity} /> : <span className="text-xs text-muted">Off</span>}
                    </td>
                  );
                })}
                <td className="py-2 text-right">
                  {!onPublished(c.code) && (
                    <button
                      className="text-muted hover:text-critical disabled:opacity-50"
                      title="Remove (not on any published scorecard yet)"
                      disabled={remove.isPending}
                      onClick={() => window.confirm(`Remove ${c.code} from the library and the drafts?`) && remove.mutate(c.code)}
                    >
                      <Trash2 size={15} aria-label={`Remove ${c.code}`} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {remove.error && <p className="mt-2 text-sm text-critical">{remove.error.message}</p>}
      <p className="mt-3 text-xs text-muted">
        "Off" means the condition is on the scorecard but disabled until the data it needs exists. Published conditions can't be edited or removed; a
        new scorecard version can disable one instead.
      </p>
    </Card>
  );
}

/** PRD §4.5: the failure-condition library, adding a condition, and publishing the scorecard drafts. v2 only. */
export function Conditions() {
  const list = useQuery({ queryKey: ["conditions"], queryFn: conditionsApi.list });
  if (list.isPending) return <p className="text-sm text-muted">Loading…</p>;
  if (list.error) return <p className="text-sm text-critical">{list.error.message}</p>;
  const { conditions, scorecards } = list.data;
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold text-ink">Failure conditions</h1>
      <AddCondition scorecards={scorecards} />
      <Drafts scorecards={scorecards} library={conditions} />
      <Library conditions={conditions} scorecards={scorecards} />
    </div>
  );
}

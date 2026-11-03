import { type UseQueryResult, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import type { HistoryEntry, Simulation } from "../api";
import { type ScorecardAdmin, scorecardsApi } from "../api";
import {
  ChangeList,
  type ChangeNames,
  DiscardDialog,
  DraftBar,
  HistoryCard,
  PageHeader,
  PublishDialog,
  PublishedBar,
  VersionSwitch,
  type View,
  usedBy,
  useUnsavedGuard,
} from "../components/admin";
import { ConditionEditor, MetricEditor, ScorecardEditor, useDraftEdits, useScorecard } from "../components/scorecard-editor";
import { Button, Card, ErrorNote, Skeleton, SuccessBadge, VersionBadge, formatDate } from "../components/ui";

/** PRD §4: the scorecards agents are graded on. v2 only. */
export function Scorecards() {
  const list = useQuery({ queryKey: ["scorecards"], queryFn: scorecardsApi.list });
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-ink">Scorecards</h1>
        <p className="mt-0.5 text-sm text-ink-2">The metrics, weights and failure conditions each agent is graded on.</p>
      </div>
      <Card>
        {list.isPending ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-11" />
            <Skeleton className="h-11" />
          </div>
        ) : list.error ? (
          <ErrorNote>Couldn't load the scorecards. {list.error.message}</ErrorNote>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="py-2 pr-3 font-medium">Scorecard</th>
                <th className="hidden py-2 pr-3 font-medium sm:table-cell">Used by</th>
                <th className="py-2 pr-3 font-medium">Version</th>
                <th className="hidden py-2 font-medium md:table-cell">Last published</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((s) => (
                <tr key={s.scorecard_id} className="border-b border-line align-middle last:border-0 hover:bg-sunken">
                  <td className="py-2.5 pr-3">
                    <a href={`#/scorecards/${encodeURIComponent(s.scorecard_id)}`} className="font-medium text-ink hover:underline">
                      {s.name}
                    </a>
                    <div className="text-xs text-muted sm:hidden">{s.agents.map((a) => a.label).join(", ") || "No agents"}</div>
                  </td>
                  <td className="hidden py-2.5 pr-3 text-ink-2 sm:table-cell">{s.agents.map((a) => a.label).join(", ") || "—"}</td>
                  <td className="py-2.5 pr-3">
                    <div className="flex flex-wrap gap-1.5">
                      <VersionBadge status="published" version={s.published} />
                      {s.draft !== null && <VersionBadge status="draft" version={s.draft} />}
                    </div>
                  </td>
                  <td className="hidden py-2.5 text-ink-2 tabular md:table-cell">{formatDate(s.published_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

const namesOf = (admin: ScorecardAdmin): ChangeNames => ({
  metrics: Object.fromEntries([...admin.published.metrics, ...(admin.draft?.metrics ?? [])].map((m) => [m.key, m.name])),
  conditions: Object.fromEntries(admin.library.map((l) => [l.code, l.label])),
});

/** One scorecard: the live version read-only, or its draft to edit and publish (P1-18), with the simulation (P1-20). */
export function ScorecardEditorPage({ id }: { id: string }) {
  const admin = useQuery({ queryKey: ["scorecard", id], queryFn: () => scorecardsApi.get(id) });
  const history = useQuery({ queryKey: ["scorecard-history", id], queryFn: () => scorecardsApi.history(id) });
  const [view, setView] = useState<View>("draft");

  if (admin.isPending)
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-12 w-64" />
        <Skeleton className="h-14" />
        <Skeleton className="h-96" />
      </div>
    );
  if (admin.error) return <ErrorNote>Couldn't load this scorecard. {admin.error.message}</ErrorNote>;
  const a = admin.data;
  const showDraft = a.draft !== null && view === "draft";
  const names = namesOf(a);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        crumb={{ href: "#/scorecards", label: "Scorecards" }}
        title={a.published.name}
        subtitle={usedBy(a.agents)}
        actions={a.draft && <VersionSwitch view={view} onChange={setView} draft={a.draft.version} published={a.published.version} />}
      />
      {showDraft ? (
        // Remounted after each save, so the local edits start from what was saved.
        <DraftView key={JSON.stringify(a.draft)} admin={a} names={names} history={history} />
      ) : (
        <PublishedView admin={a} names={names} history={history} onOpenDraft={() => setView("draft")} />
      )}
    </div>
  );
}

type HistoryQuery = UseQueryResult<HistoryEntry[], Error>;

function PublishedView({ admin, names, history, onOpenDraft }: { admin: ScorecardAdmin; names: ChangeNames; history: HistoryQuery; onOpenDraft: () => void }) {
  const qc = useQueryClient();
  const start = useMutation({
    mutationFn: () => scorecardsApi.startDraft(admin.scorecard_id),
    onSuccess: (data) => {
      qc.setQueryData(["scorecard", admin.scorecard_id], data);
      qc.invalidateQueries({ queryKey: ["scorecard-history", admin.scorecard_id] });
      qc.invalidateQueries({ queryKey: ["scorecards"] });
      onOpenDraft();
    },
  });
  return (
    <ScorecardEditor.Published admin={admin}>
      <PublishedBar
        version={admin.published.version}
        publishedAt={admin.published.published_at}
        action={
          admin.draft ? (
            <Button variant="secondary" compact onClick={onOpenDraft}>
              Open draft v{admin.draft.version}
            </Button>
          ) : (
            <Button variant="primary" compact onClick={() => start.mutate()} disabled={start.isPending}>
              {start.isPending ? "Starting…" : "Start a draft"}
            </Button>
          )
        }
      />
      {start.error && <ErrorNote>{start.error.message}</ErrorNote>}
      <Layout main={<ScorecardBody />} aside={<HistoryCard entries={history.data} names={names} isPending={history.isPending} error={history.error} />} />
    </ScorecardEditor.Published>
  );
}

function DraftView({ admin, names, history }: { admin: ScorecardAdmin; names: ChangeNames; history: HistoryQuery }) {
  const qc = useQueryClient();
  const draft = useDraftEdits(admin.draft!);
  const [dialog, setDialog] = useState<"publish" | "discard" | null>(null);
  const [n, setN] = useState(100);
  useUnsavedGuard(draft.unsaved);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["scorecard-history", admin.scorecard_id] });
    qc.invalidateQueries({ queryKey: ["simulation", admin.scorecard_id] });
    qc.invalidateQueries({ queryKey: ["scorecards"] });
    qc.invalidateQueries({ queryKey: ["conditions"] });
  };
  const save = useMutation({
    mutationFn: () => scorecardsApi.saveDraft(admin.scorecard_id, draft.patch!),
    onSuccess: (data) => {
      qc.setQueryData(["scorecard", admin.scorecard_id], data);
      refresh();
    },
  });
  const publish = useMutation({
    mutationFn: () => scorecardsApi.publish(admin.scorecard_id),
    onSuccess: () => {
      setDialog(null);
      qc.invalidateQueries({ queryKey: ["scorecard", admin.scorecard_id] });
      refresh();
    },
  });
  const discard = useMutation({
    mutationFn: () => scorecardsApi.discard(admin.scorecard_id),
    onSuccess: () => {
      setDialog(null);
      qc.invalidateQueries({ queryKey: ["scorecard", admin.scorecard_id] });
      refresh();
    },
  });
  const simulation = useQuery({ queryKey: ["simulation", admin.scorecard_id, n], queryFn: () => scorecardsApi.simulate(admin.scorecard_id, n) });

  const d = admin.draft!;
  const live = admin.published.version;
  const who = admin.agents.map((x) => x.label).join(" and ") || "No agent is";
  const blockedBecause = draft.unsaved
    ? "Save your changes before publishing."
    : admin.changes.length === 0
      ? `Nothing to publish yet: this draft matches v${live}.`
      : admin.publish_errors.length
        ? `Fix before publishing: ${admin.publish_errors.join("; ")}.`
        : null;

  return (
    <ScorecardEditor.Draft admin={admin} draft={draft}>
      <DraftBar
        version={d.version}
        liveVersion={live}
        who={who}
        changes={admin.changes.length}
        unsaved={draft.unsaved}
        saving={save.isPending}
        onSave={() => save.mutate()}
        onDiscard={() => setDialog("discard")}
        onReview={() => setDialog("publish")}
        blockedBecause={blockedBecause}
      />
      {save.error && <ErrorNote>Couldn't save the draft. {save.error.message}</ErrorNote>}
      <Layout
        main={<ScorecardBody />}
        aside={
          <>
            <SimulationCard admin={admin} n={n} onN={setN} query={simulation} unsaved={draft.unsaved} />
            <Card title="Changes in this draft">
              {admin.changes.length ? (
                <ChangeList changes={admin.changes} names={names} limit={8} />
              ) : (
                <p className="text-sm text-muted">No saved changes yet. Edit a weight, rubric or condition, then save the draft.</p>
              )}
            </Card>
            <HistoryCard entries={history.data} names={names} isPending={history.isPending} error={history.error} />
          </>
        }
      />
      <PublishDialog
        open={dialog === "publish"}
        onClose={() => setDialog(null)}
        onConfirm={() => publish.mutate()}
        pending={publish.isPending}
        error={publish.error}
        title={`Publish ${admin.published.name} v${d.version}?`}
        version={d.version}
      >
        <p>
          {admin.agents.length
            ? `${admin.agents.map((x) => x.label).join(" and ")} move from v${live} to v${d.version}, and their next v2 audits use it.`
            : `No agent uses v${live}, so no agent moves.`}{" "}
          Past audits keep the version they were graded on.
        </p>
        <div className="rounded-lg border border-line p-3">
          <ChangeList changes={admin.changes} names={names} limit={6} />
        </div>
        <SimulationLine query={simulation} />
      </PublishDialog>
      <DiscardDialog
        open={dialog === "discard"}
        onClose={() => setDialog(null)}
        onConfirm={() => discard.mutate()}
        pending={discard.isPending}
        error={discard.error}
        version={d.version}
        liveVersion={live}
      />
    </ScorecardEditor.Draft>
  );
}

/** Main column and a right rail from `lg` up; stacked on smaller screens. */
function Layout({ main, aside }: { main: ReactNode; aside: ReactNode }) {
  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="flex min-w-0 flex-col gap-4">{main}</div>
      <aside className="flex min-w-0 flex-col gap-4">{aside}</aside>
    </div>
  );
}

function ScorecardBody() {
  const scorecard = useScorecard();
  return (
    <>
      <Card title="Pass rule">
        <ScorecardEditor.Threshold />
      </Card>
      <Card title="Metrics" action={<ScorecardEditor.WeightTotal />}>
        <ul className="flex flex-col divide-y divide-line">
          {scorecard.metrics.map((m) => (
            <MetricEditor.Root key={m.key} metricKey={m.key}>
              <div className="grid gap-x-4 gap-y-2 md:grid-cols-[minmax(0,1fr)_minmax(15rem,20rem)] md:items-center">
                <MetricEditor.Header />
                <MetricEditor.Weight />
              </div>
              <MetricEditor.Details>
                <MetricEditor.Rubric />
                <MetricEditor.Applicability />
                <MetricEditor.AutoFail />
              </MetricEditor.Details>
            </MetricEditor.Root>
          ))}
        </ul>
      </Card>
      <Card title="Failure conditions" action={<a href="#/conditions" className="text-xs text-accent hover:underline">Add a condition</a>}>
        <ul className="flex flex-col divide-y divide-line">
          {scorecard.conditions.map((c) => (
            <ConditionEditor.Root key={c.condition_code} code={c.condition_code}>
              <ConditionEditor.Label />
              <ConditionEditor.Controls>
                <ConditionEditor.Enabled />
                <ConditionEditor.Severity />
                <ConditionEditor.Metric />
              </ConditionEditor.Controls>
            </ConditionEditor.Root>
          ))}
        </ul>
      </Card>
    </>
  );
}

type SimulationQuery = UseQueryResult<Simulation, Error>;
const pct = (v: number | null) => (v === null ? "—" : `${v}%`);
const fmt = (v: number | null) => (v === null ? "—" : v.toFixed(1));
const pts = (before: number | null, after: number | null) => {
  if (before === null || after === null) return "";
  const d = Math.round((after - before) * 10) / 10;
  return d === 0 ? "no change" : `${d > 0 ? "+" : "−"}${Math.abs(d)} pts`;
};

/** P1-20: what publishing the saved draft would do to the pass rate of recent audits, re-scored from stored scores. */
function SimulationCard({ admin, n, onN, query, unsaved }: { admin: ScorecardAdmin; n: number; onN: (n: number) => void; query: SimulationQuery; unsaved: boolean }) {
  const names = Object.fromEntries(admin.published.metrics.map((m) => [m.key, m.name]));
  const s = query.data;
  return (
    <Card
      title="If you publish"
      action={
        <select
          aria-label="How many recent audits to re-score"
          value={n}
          onChange={(e) => onN(Number(e.target.value))}
          className="h-7 rounded-md border border-control bg-surface px-1.5 text-xs text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          {[50, 100, 250, 500].map((x) => (
            <option key={x} value={x}>
              Last {x} audits
            </option>
          ))}
        </select>
      }
    >
      {query.isPending ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-4 w-56" />
        </div>
      ) : query.error ? (
        <ErrorNote>Couldn't run the simulation. {query.error.message}</ErrorNote>
      ) : s!.audits === 0 ? (
        <p className="text-sm text-muted">
          No v2 audits on this scorecard yet. Audit some calls with v2 to see how this draft would change their results.
        </p>
      ) : (
        <div className={`flex flex-col gap-3 ${query.isFetching ? "opacity-60" : ""}`}>
          <div>
            <div className="text-xs text-muted">Pass rate</div>
            <div className="flex items-baseline gap-2 text-ink tabular">
              <span className="text-base text-ink-2">{pct(s!.before.pass_rate)}</span>
              <span aria-label="would become" className="text-muted">
                →
              </span>
              <span className="text-2xl font-semibold">{pct(s!.after.pass_rate)}</span>
              <span className="text-xs text-muted">{pts(s!.before.pass_rate, s!.after.pass_rate)}</span>
            </div>
          </div>
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <div>
              <dt className="text-xs text-muted">Average score</dt>
              <dd className="text-ink tabular">
                {fmt(s!.before.average_score)} → {fmt(s!.after.average_score)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Audits</dt>
              <dd className="text-ink tabular">{s!.audits}</dd>
            </div>
          </dl>
          {s!.flipped.length === 0 ? (
            <p className="text-sm text-ink-2">No call changes from pass to fail or back.{s!.score_changed > 0 && ` ${s!.score_changed} scores move.`}</p>
          ) : (
            <div>
              <div className="mb-1 text-xs text-muted">
                {s!.flipped.length} {s!.flipped.length === 1 ? "call changes" : "calls change"} verdict
              </div>
              <ul className="flex flex-col divide-y divide-line text-sm">
                {s!.flipped.slice(0, 8).map((f) => (
                  <li key={f.audit_id} className="flex items-center justify-between gap-2 py-1.5">
                    <a href={`#/calls/${f.call_id}`} className="text-ink hover:underline tabular">
                      Call #{f.call_id}
                    </a>
                    <span className="flex items-center gap-1.5 text-xs text-ink-2 tabular">
                      {fmt(f.before.score)} → {fmt(f.after.score)}
                      <SuccessBadge result={f.after.passed ? "PASS" : "FAIL"} />
                    </span>
                  </li>
                ))}
              </ul>
              {s!.flipped.length > 8 && <p className="mt-1 text-xs text-muted">and {s!.flipped.length - 8} more</p>}
            </div>
          )}
          <ul className="flex flex-col gap-1 text-xs text-ink-2">
            {s!.audits < 30 && <li>Only {s!.audits} audits back this (under 30): read it as a rough guide.</li>}
            {s!.unscored.audits > 0 && (
              <li>
                {s!.unscored.metrics.map((k) => names[k] ?? k).join(" and ")}: no score on {s!.unscored.audits} of these audits (weighted 0
                when audited), so counted as N/A there.
              </li>
            )}
            {unsaved && <li>Shows the saved draft. Save to include your latest edits.</li>}
            <li>Re-scored from stored metric scores; no new LLM calls.</li>
          </ul>
        </div>
      )}
    </Card>
  );
}

const calls = (n: number) => `${n} ${n === 1 ? "call" : "calls"}`;
/** "3 calls that pass today would fail, and 1 that fails would pass." Leaves out a side with none. */
const flips = (fail: number, pass: number) =>
  fail && pass
    ? `${calls(fail)} that pass today would fail, and ${pass} that ${pass === 1 ? "fails" : "fail"} would pass.`
    : fail
      ? `${calls(fail)} that ${fail === 1 ? "passes" : "pass"} today would fail.`
      : `${calls(pass)} that ${pass === 1 ? "fails" : "fail"} today would pass.`;

function SimulationLine({ query }: { query: SimulationQuery }) {
  const s = query.data;
  if (!s) return null;
  if (s.audits === 0) return <p>No v2 audits on this scorecard yet, so there's no pass-rate preview.</p>;
  const fail = s.flipped.filter((f) => !f.after.passed).length;
  const pass = s.flipped.length - fail;
  return (
    <p className="tabular">
      On the last {s.audits} audits, the pass rate goes from {pct(s.before.pass_rate)} to <span className="font-semibold text-ink">{pct(s.after.pass_rate)}</span>
      {s.flipped.length === 0 ? ", and no call changes verdict." : `. ${flips(fail, pass)}`}
    </p>
  );
}


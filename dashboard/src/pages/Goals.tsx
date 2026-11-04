import { type UseQueryResult, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, createContext, use, useId, useMemo, useState } from "react";
import { type BusinessOutcome, type GoalAdmin, type GoalConfig, type GoalTemplate, type HistoryEntry, goalsApi } from "../api";
import {
  ChangeList,
  DiscardDialog,
  DraftBar,
  HistoryCard,
  ListEditor,
  ListView,
  PageHeader,
  PublishDialog,
  PublishedBar,
  VersionSwitch,
  type View,
  useUnsavedGuard,
} from "../components/admin";
import { goalPatch } from "../lib/admin-logic";
import { Button, Card, Dialog, ErrorNote, Input, Skeleton, Textarea, VersionBadge, formatDate } from "../components/ui";

/** PRD §3.2: each agent's business goal and system goal settings. v2 only. */
export function Goals() {
  const list = useQuery({ queryKey: ["goals"], queryFn: goalsApi.list });
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-ink">Goals</h1>
        <p className="mt-0.5 text-sm text-ink-2">What each agent's calls are for, and what the system goal checks.</p>
      </div>
      <Card>
        {list.isPending ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-11" />
            <Skeleton className="h-11" />
            <Skeleton className="h-11" />
          </div>
        ) : list.error ? (
          <ErrorNote>Couldn't load the goals. {list.error.message}</ErrorNote>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="py-2 pr-3 font-medium">Agent</th>
                <th className="hidden py-2 pr-3 font-medium sm:table-cell">Business goal</th>
                <th className="py-2 pr-3 font-medium">Version</th>
                <th className="hidden py-2 font-medium md:table-cell">Last published</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((g) => (
                <tr key={g.agent_code} className="border-b border-line align-middle last:border-0 hover:bg-sunken">
                  <td className="py-2.5 pr-3">
                    <a href={`#/goals/${encodeURIComponent(g.agent_code)}`} className="font-medium text-ink hover:underline">
                      {g.label}
                    </a>
                    <div className="text-xs text-muted sm:hidden">{g.name ?? "No goal yet"}</div>
                  </td>
                  <td className="hidden py-2.5 pr-3 text-ink-2 sm:table-cell">{g.name ?? "—"}</td>
                  <td className="py-2.5 pr-3">
                    <div className="flex flex-wrap gap-1.5">
                      {g.published !== null ? <VersionBadge status="published" version={g.published} /> : <span className="text-muted">—</span>}
                      {g.draft !== null && <VersionBadge status="draft" version={g.draft} />}
                    </div>
                  </td>
                  <td className="hidden py-2.5 text-ink-2 tabular md:table-cell">{formatDate(g.published_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

// ---- The goal form: one context for the goal being shown; read-only for the live version, editable for a draft ----

type Editable = Pick<
  GoalConfig,
  "name" | "description" | "success_criteria" | "partial_success" | "not_applicable_when" | "required_outputs" | "reason_codes" | "system_checks"
>;
type GoalForm = { goal: Editable; live: GoalConfig | null; mode: "view" | "edit"; update: (edit: Partial<Editable>) => void };
const GoalFormContext = createContext<GoalForm | null>(null);
const useGoalForm = () => use(GoalFormContext)!;

const editable = (g: GoalConfig): Editable => ({
  name: g.name,
  description: g.description,
  success_criteria: g.success_criteria,
  partial_success: g.partial_success,
  not_applicable_when: g.not_applicable_when,
  required_outputs: g.required_outputs,
  reason_codes: g.reason_codes,
  system_checks: g.system_checks,
});
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const OUTCOMES: BusinessOutcome[] = ["ACHIEVED", "PARTIAL", "NOT_ACHIEVED", "NOT_APPLICABLE"];

/** One settings section: a title and a short description beside its fields (stacked on small screens). */
function Section({ title, description, children }: { title: string; description: ReactNode; children: ReactNode }) {
  return (
    <section className="grid gap-x-8 gap-y-3 border-b border-line py-6 first:pt-0 last:border-0 last:pb-0 md:grid-cols-[15rem_minmax(0,1fr)]">
      <div>
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        <p className="mt-1 text-sm text-ink-2">{description}</p>
      </div>
      <div className="flex min-w-0 flex-col gap-5">{children}</div>
    </section>
  );
}

/** A labelled field; in a draft, a 2px accent rule marks it when it differs from the live version. */
function Field({ label, hint, changed, htmlFor, children }: { label: string; hint?: ReactNode; changed: boolean; htmlFor?: string; children: ReactNode }) {
  const { mode } = useGoalForm();
  const marked = mode === "edit" && changed;
  return (
    <div className="relative flex flex-col gap-1.5">
      {marked && <span className="absolute inset-y-0 -left-3 w-0.5 rounded-full bg-accent" aria-hidden />}
      {htmlFor ? (
        <label htmlFor={htmlFor} className="text-sm font-medium text-ink">
          {label}
          {marked && <span className="sr-only"> (changed in this draft)</span>}
        </label>
      ) : (
        <div className="text-sm font-medium text-ink">{label}</div>
      )}
      {hint && <p className="-mt-1 text-xs text-ink-2">{hint}</p>}
      {children}
    </div>
  );
}

function TextInput({ field, label }: { field: "name"; label: string }) {
  const { goal, live, mode, update } = useGoalForm();
  const id = useId();
  return (
    <Field label={label} htmlFor={id} changed={!same(goal[field], live?.[field])}>
      {mode === "view" ? (
        <p className="text-sm text-ink">{goal[field] || "—"}</p>
      ) : (
        <Input id={id} value={goal[field]} maxLength={120} onChange={(e) => update({ [field]: e.target.value })} />
      )}
    </Field>
  );
}

function TextAreaInput({ field, label }: { field: "description"; label: string }) {
  const { goal, live, mode, update } = useGoalForm();
  const id = useId();
  return (
    <Field label={label} htmlFor={id} changed={!same(goal[field], live?.[field])}>
      {mode === "view" ? (
        <p className="text-sm text-ink">{goal[field] || "—"}</p>
      ) : (
        <Textarea id={id} rows={2} value={goal[field]} onChange={(e) => update({ [field]: e.target.value })} />
      )}
    </Field>
  );
}

type ListField = "success_criteria" | "partial_success" | "not_applicable_when" | "required_outputs";
function ListInput({ field, label, hint, placeholder, variant, empty }: { field: ListField; label: string; hint?: string; placeholder: string; variant?: "code"; empty: string }) {
  const { goal, live, mode, update } = useGoalForm();
  const id = useId();
  return (
    <Field label={label} hint={hint} htmlFor={mode === "edit" ? id : undefined} changed={!same(goal[field], live?.[field])}>
      {mode === "view" ? (
        <ListView value={goal[field]} variant={variant} empty={empty} />
      ) : (
        <ListEditor id={id} label={label} value={goal[field]} onChange={(v) => update({ [field]: v })} placeholder={placeholder} variant={variant} />
      )}
    </Field>
  );
}

const OUTCOME_LABEL: Record<BusinessOutcome, { label: string; hint: string }> = {
  ACHIEVED: { label: "Achieved", hint: "Counts toward the goal rate." },
  PARTIAL: { label: "Partial", hint: "Shown next to the goal rate; doesn't count as achieved." },
  NOT_ACHIEVED: { label: "Not achieved", hint: "The auditor picks one of these reasons, so misses can be broken down." },
  NOT_APPLICABLE: { label: "Not applicable", hint: "Left out of the goal rate." },
};

function OutcomeCodes({ outcome }: { outcome: BusinessOutcome }) {
  const { goal, live, mode, update } = useGoalForm();
  const id = useId();
  const codes = goal.reason_codes[outcome] ?? [];
  const off = outcome === "PARTIAL" && goal.partial_success.length === 0;
  const { label, hint } = OUTCOME_LABEL[outcome];
  return (
    <Field
      label={label}
      hint={off ? "Not offered: add a partial success criterion above to use it." : hint}
      htmlFor={mode === "edit" && !off ? id : undefined}
      changed={!same(codes, live?.reason_codes[outcome] ?? [])}
    >
      {off ? null : mode === "view" ? (
        <ListView value={codes} variant="code" empty="No reason codes" />
      ) : (
        <ListEditor
          id={id}
          label={`${label} reason code`}
          value={codes}
          variant="code"
          placeholder="Add a code, e.g. PRICE…"
          addLabel="Add code"
          onChange={(v) => update({ reason_codes: { ...goal.reason_codes, [outcome]: v.map((c) => c.toUpperCase()) } })}
        />
      )}
    </Field>
  );
}

function SystemSettings() {
  const { goal, live, mode, update } = useGoalForm();
  const varsId = useId();
  const stepsId = useId();
  const silenceId = useId();
  const sc = goal.system_checks;
  return (
    <>
      <Field
        label="Required variables"
        hint="Checked by S4 (data saved) when the call's save tool lists none."
        htmlFor={mode === "edit" ? varsId : undefined}
        changed={!same(sc.required_variables, live?.system_checks.required_variables)}
      >
        {mode === "view" ? (
          <ListView value={sc.required_variables} variant="code" empty="None" />
        ) : (
          <ListEditor
            id={varsId}
            label="Required variable"
            value={sc.required_variables}
            variant="code"
            placeholder="Add a variable, e.g. outcome.contact_channel…"
            addLabel="Add variable"
            onChange={(required_variables) => update({ system_checks: { ...sc, required_variables } })}
          />
        )}
      </Field>
      <Field
        label="Flow steps"
        hint="Saved with the goal; the judge doesn't use them yet. It reads the flow from the Caller workflow or the agent's prompt."
        htmlFor={mode === "edit" ? stepsId : undefined}
        changed={!same(sc.flow_steps ?? [], live?.system_checks.flow_steps ?? [])}
      >
        {mode === "view" ? (
          <ListView value={sc.flow_steps ?? []} empty="None set" />
        ) : (
          <ListEditor
            id={stepsId}
            label="Flow step"
            value={sc.flow_steps ?? []}
            placeholder="Add a step…"
            addLabel="Add step"
            onChange={(steps) => update({ system_checks: { ...sc, flow_steps: steps.length ? steps : null } })}
          />
        )}
      </Field>
      <Field label="Silence limit" hint="Needs call timing data, which calls don't have yet." htmlFor={silenceId} changed={false}>
        <div className="flex items-center gap-2">
          <Input id={silenceId} className="w-20 tabular" value={sc.silence_limit_s} disabled readOnly />
          <span className="text-sm text-ink-2">seconds</span>
        </div>
      </Field>
    </>
  );
}

function GoalBody({ action }: { action?: ReactNode }) {
  return (
    <Card>
      <Section
        title="Business goal"
        description={
          <>
            What a successful call achieves for this agent. The auditor gets this definition in full.
            {action && <span className="mt-3 block">{action}</span>}
          </>
        }
      >
        <TextInput field="name" label="Name" />
        <TextAreaInput field="description" label="Description" />
        <ListInput field="success_criteria" label="Success when" placeholder="Add a success criterion…" empty="None" />
        <ListInput
          field="partial_success"
          label="Partial success when"
          hint="Optional. Leave empty if a call either achieves the goal or doesn't."
          placeholder="Add a partial-success case…"
          empty="Not used"
        />
        <ListInput field="not_applicable_when" label="Not applicable when" placeholder="Add a case…" empty="None" />
        <ListInput
          field="required_outputs"
          label="Required outputs"
          hint="Variables the call must capture when it succeeds."
          placeholder="Add an output, e.g. demo_datetime…"
          variant="code"
          empty="None"
        />
      </Section>
      <Section title="Outcome values" description="The four outcomes the auditor chooses from, each with the reasons it can give.">
        {OUTCOMES.map((o) => (
          <OutcomeCodes key={o} outcome={o} />
        ))}
      </Section>
      <Section title="System goal settings" description="What the system goal checks for this agent, on top of the fixed checks S1–S4.">
        <SystemSettings />
      </Section>
    </Card>
  );
}

// ---- Template picker ------------------------------------------------------------------------------------------------

function TemplatePicker({ open, onClose, onPick, pending, error, confirmLabel }: { open: boolean; onClose: () => void; onPick: (t: GoalTemplate) => void; pending: boolean; error: Error | null; confirmLabel: string }) {
  const templates = useQuery({ queryKey: ["goal-templates"], queryFn: goalsApi.templates, staleTime: Infinity, enabled: open });
  const [picked, setPicked] = useState<string | null>(null);
  const t = templates.data?.find((x) => x.id === picked) ?? null;
  const name = useId();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="wide"
      title="Start from a template"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} data-autofocus>
            Cancel
          </Button>
          <Button variant="primary" disabled={!t || pending} onClick={() => t && onPick(t)}>
            {pending ? "Starting…" : confirmLabel}
          </Button>
        </>
      }
    >
      <p>A template fills in the business goal: name, criteria, outputs and reason codes. You can change any of it before publishing. System goal settings stay as they are.</p>
      {templates.isPending ? (
        <Skeleton className="h-40" />
      ) : templates.error ? (
        <ErrorNote>Couldn't load the templates. {templates.error.message}</ErrorNote>
      ) : (
        <div className="grid gap-3 sm:grid-cols-[13rem_minmax(0,1fr)]">
          <fieldset className="flex flex-col gap-1">
            <legend className="sr-only">Template</legend>
            {templates.data!.map((x) => (
              <label key={x.id} className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-ink hover:bg-sunken ${picked === x.id ? "bg-accent-track" : ""}`}>
                <input type="radio" name={name} value={x.id} checked={picked === x.id} onChange={() => setPicked(x.id)} className="accent-[var(--accent)]" />
                {x.name}
              </label>
            ))}
          </fieldset>
          <div className="min-h-48 rounded-lg bg-sunken p-3 text-sm">
            {t ? (
              <dl className="flex flex-col gap-2">
                <div>
                  <dt className="text-xs text-muted">Success when</dt>
                  <dd className="text-ink">{t.success_criteria.join("; ")}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Partial success when</dt>
                  <dd className="text-ink">{t.partial_success.join("; ") || "Not used"}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Not applicable when</dt>
                  <dd className="text-ink">{t.not_applicable_when.slice(3).join("; ")} (plus wrong person, voicemail and unusable audio)</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Required outputs</dt>
                  <dd className="font-mono text-[13px] text-ink">{t.required_outputs.join(", ")}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Not achieved reasons</dt>
                  <dd className="font-mono text-[13px] text-ink">{(t.reason_codes.NOT_ACHIEVED ?? []).join(", ")}</dd>
                </div>
              </dl>
            ) : (
              <p className="text-muted">Pick a template to see what it fills in.</p>
            )}
          </div>
        </div>
      )}
      {error && <ErrorNote>{error.message}</ErrorNote>}
    </Dialog>
  );
}

// ---- The editor page ------------------------------------------------------------------------------------------------

type HistoryQuery = UseQueryResult<HistoryEntry[], Error>;

/** One agent's goal: the live version read-only, or its draft to edit and publish (P1-18). */
export function GoalEditorPage({ agent }: { agent: string }) {
  const admin = useQuery({ queryKey: ["goal", agent], queryFn: () => goalsApi.get(agent) });
  const history = useQuery({ queryKey: ["goal-history", agent], queryFn: () => goalsApi.history(agent) });
  const [view, setView] = useState<View>("draft");

  if (admin.isPending)
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-12 w-64" />
        <Skeleton className="h-14" />
        <Skeleton className="h-96" />
      </div>
    );
  if (admin.error) return <ErrorNote>Couldn't load this goal. {admin.error.message}</ErrorNote>;
  const a = admin.data;
  const showDraft = a.draft !== null && (view === "draft" || a.published === null);
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        crumb={{ href: "#/goals", label: "Goals" }}
        title={a.label}
        subtitle={(a.draft && showDraft ? a.draft : a.published)?.name ?? "No goal yet"}
        actions={a.draft && a.published && <VersionSwitch view={view} onChange={setView} draft={a.draft.version} published={a.published.version} />}
      />
      {showDraft ? (
        <GoalDraftView key={JSON.stringify(a.draft)} admin={a} history={history} />
      ) : a.published ? (
        <GoalPublishedView admin={a} history={history} onOpenDraft={() => setView("draft")} />
      ) : (
        <p className="text-sm text-muted">This agent has no goal yet.</p>
      )}
    </div>
  );
}

function Rail({ main, aside }: { main: ReactNode; aside: ReactNode }) {
  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="min-w-0">{main}</div>
      <aside className="flex min-w-0 flex-col gap-4">{aside}</aside>
    </div>
  );
}

function GoalPublishedView({ admin, history, onOpenDraft }: { admin: GoalAdmin; history: HistoryQuery; onOpenDraft: () => void }) {
  const qc = useQueryClient();
  const [picking, setPicking] = useState(false);
  const start = useMutation({
    mutationFn: (template?: string) => goalsApi.startDraft(admin.agent_code, template),
    onSuccess: (data) => {
      setPicking(false);
      qc.setQueryData(["goal", admin.agent_code], data);
      qc.invalidateQueries({ queryKey: ["goal-history", admin.agent_code] });
      qc.invalidateQueries({ queryKey: ["goals"] });
      onOpenDraft();
    },
  });
  const live = admin.published!;
  const form: GoalForm = { goal: editable(live), live, mode: "view", update: () => {} };
  return (
    <GoalFormContext value={form}>
      <PublishedBar
        version={live.version}
        publishedAt={live.published_at}
        action={
          admin.draft ? (
            <Button variant="secondary" compact onClick={onOpenDraft}>
              Open draft v{admin.draft.version}
            </Button>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" compact onClick={() => setPicking(true)}>
                Start from a template
              </Button>
              <Button variant="primary" compact onClick={() => start.mutate(undefined)} disabled={start.isPending}>
                {start.isPending && !picking ? "Starting…" : "Start a draft"}
              </Button>
            </div>
          )
        }
      />
      {start.error && !picking && <ErrorNote>{start.error.message}</ErrorNote>}
      <Rail main={<GoalBody />} aside={<HistoryCard entries={history.data} isPending={history.isPending} error={history.error} />} />
      <TemplatePicker
        open={picking}
        onClose={() => setPicking(false)}
        onPick={(t) => start.mutate(t.id)}
        pending={start.isPending}
        error={picking ? start.error : null}
        confirmLabel="Start a draft from it"
      />
    </GoalFormContext>
  );
}

function GoalDraftView({ admin, history }: { admin: GoalAdmin; history: HistoryQuery }) {
  const qc = useQueryClient();
  const saved = admin.draft!;
  const [goal, setGoal] = useState<Editable>(() => editable(saved));
  const [dialog, setDialog] = useState<"publish" | "discard" | "template" | null>(null);
  const patch = useMemo(() => goalPatch(saved, goal), [saved, goal]);
  useUnsavedGuard(patch !== null);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["goal-history", admin.agent_code] });
    qc.invalidateQueries({ queryKey: ["goals"] });
  };
  const save = useMutation({
    mutationFn: () => goalsApi.saveDraft(admin.agent_code, patch!),
    onSuccess: (data) => {
      qc.setQueryData(["goal", admin.agent_code], data);
      refresh();
    },
  });
  const publish = useMutation({
    mutationFn: () => goalsApi.publish(admin.agent_code),
    onSuccess: (data) => {
      setDialog(null);
      qc.setQueryData(["goal", admin.agent_code], data);
      refresh();
    },
  });
  const discard = useMutation({
    mutationFn: () => goalsApi.discard(admin.agent_code),
    onSuccess: () => {
      setDialog(null);
      qc.invalidateQueries({ queryKey: ["goal", admin.agent_code] });
      refresh();
    },
  });

  const live = admin.published;
  const unsaved = patch !== null;
  const blockedBecause = unsaved
    ? "Save your changes before publishing."
    : live && admin.changes.length === 0
      ? `Nothing to publish yet: this draft matches v${live.version}.`
      : admin.publish_errors.length
        ? `Fix before publishing: ${admin.publish_errors.join("; ")}.`
        : null;
  const form: GoalForm = { goal, live, mode: "edit", update: (edit) => setGoal((g) => ({ ...g, ...edit })) };

  return (
    <GoalFormContext value={form}>
      <DraftBar
        version={saved.version}
        liveVersion={live?.version ?? null}
        who={admin.label}
        changes={admin.changes.length}
        unsaved={unsaved}
        saving={save.isPending}
        onSave={() => save.mutate()}
        onDiscard={() => setDialog("discard")}
        onReview={() => setDialog("publish")}
        blockedBecause={blockedBecause}
      />
      {save.error && <ErrorNote>Couldn't save the draft. {save.error.message}</ErrorNote>}
      <Rail
          main={
            <GoalBody
              action={
                <Button variant="secondary" compact onClick={() => setDialog("template")}>
                  Replace with a template
                </Button>
              }
            />
          }
          aside={
            <>
              <Card title="Changes in this draft">
                {admin.changes.length ? (
                  <ChangeList changes={admin.changes} limit={8} />
                ) : (
                  <p className="text-sm text-muted">No saved changes yet. Edit the goal, then save the draft.</p>
                )}
              </Card>
              <HistoryCard entries={history.data} isPending={history.isPending} error={history.error} />
            </>
          }
        />
      <TemplatePicker
        open={dialog === "template"}
        onClose={() => setDialog(null)}
        onPick={({ id: _, ...t }) => {
          // Fills the form only; nothing is saved until Save draft. Every outcome is replaced, so old codes don't linger.
          setGoal((g) => ({ ...g, ...t, reason_codes: { ...t.reason_codes } }));
          setDialog(null);
        }}
        pending={false}
        error={null}
        confirmLabel="Use this template"
      />
      <PublishDialog
        open={dialog === "publish"}
        onClose={() => setDialog(null)}
        onConfirm={() => publish.mutate()}
        pending={publish.isPending}
        error={publish.error}
        title={`Publish ${admin.label}'s goal v${saved.version}?`}
        version={saved.version}
      >
        <p>
          {admin.label}'s next v2 audits use v{saved.version}
          {live ? ` instead of v${live.version}` : ""}. Past audits keep the goal version they were graded on.
        </p>
        <div className="rounded-lg border border-line p-3">
          <ChangeList changes={admin.changes} limit={6} />
        </div>
      </PublishDialog>
      <DiscardDialog
        open={dialog === "discard"}
        onClose={() => setDialog(null)}
        onConfirm={() => discard.mutate()}
        pending={discard.isPending}
        error={discard.error}
        version={saved.version}
        liveVersion={live?.version ?? null}
      />
    </GoalFormContext>
  );
}

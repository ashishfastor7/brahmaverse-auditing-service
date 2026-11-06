import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Play, RefreshCw } from "lucide-react";
import { useRef, ViewTransition } from "react";
import { auditV2Api, callsApi, type AuditResultV2, type AuditView } from "../api";
import { Card, ErrorNote, formatDate, formatDuration, humanize, Skeleton, StatusBadge } from "../components/ui";
import { addMarks, Transcript, TranscriptProvider, type TurnMarks } from "../components/v2/evidence";
import { AuditHistory } from "../components/v2/history";
import { AuditorNotes } from "../components/v2/notes";
import { Flags, Scorecard, SystemChecks } from "../components/v2/reasons";
import { ReviewCard } from "../components/v2/review-panel";
import { VerdictTiles } from "../components/v2/verdict";
import { CallDetail, CallDetails, Recording } from "./CallDetail";
import { STATUS_LABEL } from "./CallList";

/**
 * The v2 call page (PRD §5; P2-1, P2-2, P2-3, P2-4), shown while AUDIT_V2_ENABLED is on. The verdict tiles lead, then
 * why: system checks, the scorecard lowest first, the flags and the auditor notes; the recording and the transcript
 * sit beside them, and every cited turn scrolls the transcript. `auditId` opens an older audit read-only.
 *
 * Deviations from the dashboard-design patterns, on purpose: no date range or filters (one call), and no timeline or
 * "seek the audio" until timing data exists (P2-17).
 */

const usd = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 4 });

/** Turn → the names of what cited it, for the transcript's inline marks (P2-2). */
function turnMarks(r: AuditResultV2, labels: Map<string, string>): TurnMarks {
  const marks: TurnMarks = new Map();
  for (const [code, c] of Object.entries(r.checks)) if (c.result === "FAIL") for (const e of c.evidence) addMarks(marks, e.turns, code);
  for (const m of r.metrics)
    if (!m.n_a && m.score !== null && (m.score < m.max || m.zeroed_by)) for (const e of m.evidence) addMarks(marks, e.turns, m.name);
  for (const f of r.flags) for (const e of f.evidence) addMarks(marks, e.turns, labels.get(f.code) ?? humanize(f.code));
  return marks;
}

function TilesSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-busy="true" aria-label="Loading the audit">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex flex-col gap-2 rounded-xl bg-surface shadow-card px-4 py-3">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-2 w-full" />
        </div>
      ))}
    </div>
  );
}

function AuditBody({ view, callId, readOnly }: { view: AuditView; callId: number; readOnly: boolean }) {
  const r = view.audit.result!;
  return (
    <>
      <VerdictTiles r={r} context={view.context} />
      {/* Phones: the review actions come straight after the verdict, not after every reason (desktop keeps them beside). */}
      {!readOnly && (
        <div className="lg:hidden">
          <ReviewCard view={view} />
        </div>
      )}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <SystemChecks r={r} context={view.context} />
          <Scorecard r={r} context={view.context} />
          <Flags r={r} context={view.context} />
          <AuditorNotes r={r} />
          <AuditHistory entries={view.history} callId={callId} shownId={view.audit.id} />
        </div>
        <RightColumn callId={callId} view={view} readOnly={readOnly} />
      </div>
    </>
  );
}

function RightColumn({ callId, view, readOnly }: { callId: number; view: AuditView | null; readOnly: boolean }) {
  const detail = useQuery({ queryKey: ["call", callId], queryFn: () => callsApi.get(callId) });
  const r = view?.audit.result ?? null;
  const labels = new Map(view?.context.conditions.map((c) => [c.code, c.label]) ?? []);
  const c = detail.data?.call;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {view && r && !readOnly && (
        <div className="hidden lg:block">
          <ReviewCard view={view} />
        </div>
      )}
      <Card title="Recording">
        {c ? <Recording id={callId} hasRecording={Boolean(c.recording_url)} /> : <Skeleton className="h-8 w-full" />}
      </Card>
      {/* Not sticky: the judge line and call details below it would scroll under a pinned transcript. A turn chip still
          brings the transcript into view (scrollIntoView scrolls the page too). */}
      <div>
        <Card title={c ? `Transcript · ${c.transcript.length} turns` : "Transcript"}>
          {c ? <Transcript turns={c.transcript} marks={r ? turnMarks(r, labels) : undefined} /> : <Skeleton className="h-40 w-full" />}
        </Card>
      </div>
      {view && r && (
        <p className="text-xs text-muted">
          Judged by {r.judge.model} with prompt {r.judge.prompt_version}
          {r.judge.instructions
            ? ` against ${r.judge.instructions.prompt_code} v${r.judge.instructions.version}`
            : ", without the agent's instructions"}{" "}
          · {r.judge.evidence_validity === null ? "" : `${Math.round(r.judge.evidence_validity * 100)}% of quotes found · `}
          audited {formatDate(view.audit.audited_at)} by {view.audit.triggered_by ?? "—"}
          {view.audit.cost !== null ? ` · ${usd.format(view.audit.cost)}` : ""}
        </p>
      )}
      {c && <CallDetails c={c} />}
    </div>
  );
}

/**
 * `#/calls/:id` with v2 on (the step 15 plan): a call audited only by v1 keeps today's v1 page, unchanged; the v2 page
 * opens when the call has a v2 audit, or no audit yet. Both lookups share their cache with the page they pick. While
 * they load, the header is already there, so the list's call id still morphs into the title.
 */
export function CallPage({ id }: { id: number }) {
  const detail = useQuery({ queryKey: ["call", id], queryFn: () => callsApi.get(id) });
  const audit = useQuery({ queryKey: ["v2-audit", id, "current"], queryFn: () => auditV2Api.forCall(id) });
  if (detail.isPending || audit.isPending)
    return (
      <div className="flex flex-col gap-4" aria-busy="true">
        <div>
          <a href="#/" className="text-sm text-muted hover:text-ink">
            ← All calls
          </a>
          <h1 className="mt-1 text-xl font-semibold text-ink">
            <ViewTransition name={`call-title-${id}`} share="call-title" default="none">
              <span>Call #{id}</span>
            </ViewTransition>
          </h1>
        </div>
        <TilesSkeleton />
      </div>
    );
  if (detail.data?.audit && audit.data === null) return <CallDetail id={id} />;
  return <CallDetailV2 id={id} />;
}

export function CallDetailV2({ id, auditId }: { id: number; auditId?: number }) {
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ["call", id], queryFn: () => callsApi.get(id) });
  const audit = useQuery({
    queryKey: ["v2-audit", id, auditId ?? "current"],
    queryFn: () => (auditId ? auditV2Api.get(auditId) : auditV2Api.forCall(id)),
  });
  const run = useMutation({
    mutationFn: () => auditV2Api.run(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["v2-audit", id] });
      qc.invalidateQueries({ queryKey: ["calls"] });
    },
  });

  const c = detail.data?.call;
  const view = audit.data ?? null;
  const shown = view?.audit ?? null;
  const readOnly = auditId !== undefined;
  // The audit shown when the page first loaded (null: none). A different one later (a re-audit, or the first audit
  // arriving) fades in so the change is noticed; the first one shown never animates.
  const initialId = useRef<number | null | undefined>(undefined);
  if (initialId.current === undefined && audit.isSuccess) initialId.current = shown?.id ?? null;
  const auditable = c ? c.status === "completed" && c.transcript.length > 0 : false;
  const hasV1 = Boolean(detail.data?.audit);

  return (
    <TranscriptProvider>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <a href={readOnly ? `#/calls/${id}` : "#/"} className="text-sm text-muted hover:text-ink">
              {readOnly ? "← Current audit" : "← All calls"}
            </a>
            <h1 className="mt-1 text-xl font-semibold text-ink">
              <ViewTransition name={`call-title-${id}`} share="call-title" default="none">
                <span>Call #{id}</span>
              </ViewTransition>
            </h1>
            <div className="mt-0.5 wrap-break-word text-sm text-muted">
              {c ? (
                <>
                  {c.agent_label ?? "Unknown agent"} · {c.call_type ?? "call"} · {STATUS_LABEL[c.status] ?? humanize(c.status)} ·{" "}
                  {formatDate(c.call_created_at)} · {formatDuration(c.duration)}
                </>
              ) : (
                <Skeleton className="h-4 w-72" />
              )}
            </div>
          </div>
          {!readOnly && auditable && (
            <div className="flex flex-col items-end gap-1">
              <button
                onClick={() => run.mutate()}
                disabled={run.isPending}
                className={`btn btn-compact ${shown?.status === "completed" ? "btn-secondary" : "btn-primary"}`}
              >
                {shown ? (
                  <RefreshCw size={14} className={run.isPending ? "animate-spin motion-reduce:animate-none" : ""} aria-hidden />
                ) : (
                  <Play size={14} aria-hidden />
                )}
                {run.isPending ? "Auditing… (about 20 s)" : shown ? "Re-audit" : "Audit this call"}
              </button>
              {run.isError && <ErrorNote>{(run.error as Error).message}</ErrorNote>}
            </div>
          )}
        </div>

        {readOnly && shown && (
          <p className="rounded-lg border border-line bg-sunken px-3 py-2 text-sm text-ink-2" role="status">
            An older audit, from {formatDate(shown.audited_at ?? shown.created_at)}, shown read-only.{" "}
            <a href={`#/calls/${id}`} className="font-medium text-accent hover:underline">
              Open the current audit
            </a>
          </p>
        )}

        {audit.isPending || detail.isPending ? (
          <TilesSkeleton />
        ) : audit.isError || detail.isError ? (
          <Card>
            <ErrorNote>Couldn't load this call: {((audit.error ?? detail.error) as Error).message}</ErrorNote>
          </Card>
        ) : shown?.status === "completed" && shown.result ? (
          <div key={shown.id} className={`flex flex-col gap-4 ${shown.id !== initialId.current ? "enter-fade" : ""}`}>
            <AuditBody view={view!} callId={id} readOnly={readOnly} />
          </div>
        ) : (
          <>
            <Card>
              <div className="flex flex-col gap-2 text-sm">
                {shown && shown.status !== "completed" ? (
                  <>
                    <StatusBadge status={shown.status} reason={shown.skip_reason} />
                    {shown.status === "failed" && <p className="text-ink-2">The auditor couldn't grade this call: {shown.error}</p>}
                  </>
                ) : auditable ? (
                  <p className="text-ink-2">Not audited with v2 yet. Audit this call to see its score, checks and notes.</p>
                ) : (
                  <p className="text-ink-2">
                    Nothing to audit:{" "}
                    {c && c.status !== "completed"
                      ? `the call never completed (${STATUS_LABEL[c.status] ?? humanize(c.status)})`
                      : "there's no transcript"}
                    .
                  </p>
                )}
                {hasV1 && (
                  <p className="text-ink-2">
                    This call has a v1 audit.{" "}
                    <a href={`#/calls/${id}/v1`} className="font-medium text-accent hover:underline">
                      Open the v1 audit
                    </a>
                  </p>
                )}
              </div>
            </Card>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <div className="flex min-w-0 flex-col gap-4">
                {view && view.history.length > 0 && <AuditHistory entries={view.history} callId={id} shownId={view.audit.id} />}
              </div>
              <RightColumn callId={id} view={null} readOnly />
            </div>
          </>
        )}
      </div>
    </TranscriptProvider>
  );
}

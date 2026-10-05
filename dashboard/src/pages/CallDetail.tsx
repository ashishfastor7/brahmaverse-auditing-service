import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, CheckCircle2, Play, RefreshCw, XCircle } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { callsApi, failureEvidence, type AuditResult, type CallFull, type Evidence, type Turn } from "../api";
import { Badge, Card, formatDate, formatDuration, GoalBadge, humanize, Meter, ReviewBadge, StatusBadge, SuccessBadge } from "../components/ui";
import { STATUS_LABEL } from "./CallList";

const SEVERITY_ICON = { high: "text-critical", medium: "text-serious", low: "text-warning" } as const;
// JSONB does not keep key order, so categories are always shown in scorecard order.
const SCORECARD_ORDER = ["opening", "communication", "troubleshooting", "query_handling", "closure"];

/** A clickable reference to a transcript turn; flags quotes the auditor could not verify. */
function TurnLink({ e, onJump }: { e: Evidence; onJump: (turn: number) => void }) {
  return (
    <button
      onClick={() => onJump(e.turn)}
      className="group flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-sunken"
      title="Show in transcript"
    >
      <span className="mt-0.5 shrink-0 rounded bg-sunken px-1.5 text-xs text-muted tabular group-hover:bg-surface">#{e.turn}</span>
      <span className="text-ink-2">
        “{e.quote}”{e.valid === false && <span className="ml-1 text-xs text-muted">(quote not found in transcript)</span>}
      </span>
    </button>
  );
}

function Transcript({ turns, active, cited }: { turns: Turn[]; active: number | null; cited: Set<number> }) {
  const refs = useRef(new Map<number, HTMLDivElement>());
  useEffect(() => {
    if (active !== null) refs.current.get(active)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [active]);

  if (turns.length === 0) return <p className="text-sm text-muted">No transcript for this call.</p>;
  return (
    <div className="flex max-h-[70vh] flex-col gap-1 overflow-y-auto pr-1">
      {turns.map((t) => (
        <div
          key={t.turn}
          ref={(el) => {
            if (el) refs.current.set(t.turn, el);
          }}
          className={`grid grid-cols-[2.25rem_4rem_1fr] gap-2 rounded-md px-2 py-1.5 text-sm transition-colors ${
            active === t.turn ? "bg-highlight" : cited.has(t.turn) ? "bg-sunken" : ""
          }`}
        >
          <span className="pt-0.5 text-xs text-muted tabular">{t.turn}</span>
          <span className={`pt-0.5 text-xs font-medium ${t.speaker === "agent" ? "text-accent" : "text-ink-2"}`}>
            {t.speaker === "agent" ? "Agent" : t.speaker === "user" ? "Caller" : humanize(t.speaker)}
          </span>
          <span className="text-ink">{t.text}</span>
        </div>
      ))}
    </div>
  );
}

function Recording({ id, hasRecording }: { id: number; hasRecording: boolean }) {
  const rec = useQuery({ queryKey: ["recording", id], queryFn: () => callsApi.recording(id), staleTime: 30 * 60_000, enabled: hasRecording });
  if (!hasRecording) return <p className="text-sm text-muted">This call has no recording.</p>;
  if (rec.isLoading) return <p className="text-sm text-muted">Loading recording…</p>;
  if (!rec.data?.url) return <p className="text-sm text-muted">Recording unavailable{rec.data?.reason ? ` — ${rec.data.reason}` : ""}.</p>;
  return <audio controls preload="none" src={rec.data.url} className="w-full" />;
}

/** Nested values (outcome, metadata, error detail) as a readable tree. */
function Tree({ value }: { value: Record<string, unknown> }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      {Object.entries(value).map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{humanize(k)}</dt>
          <dd className="min-w-0 text-ink">
            {v !== null && typeof v === "object" ? (
              <div className="border-l border-line pl-3">
                <Tree value={v as Record<string, unknown>} />
              </div>
            ) : (
              <span className="wrap-break-word whitespace-pre-wrap">{v === null || v === "" ? "—" : String(v)}</span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 wrap-break-word text-ink">{children ?? "—"}</dd>
    </div>
  );
}

/** Long variables (e.g. the whole conversation script in `prompt`) collapse instead of flooding the page. */
function Variables({ value }: { value: Record<string, unknown> }) {
  const entries = Object.entries(value);
  if (entries.length === 0) return null;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      {entries.map(([k, v]) => {
        const text = typeof v === "string" ? v : JSON.stringify(v);
        return (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className="min-w-0 text-ink">
              {text.length > 160 ? (
                <details>
                  <summary className="cursor-pointer text-ink-2">
                    {text.slice(0, 120)}… <span className="text-xs text-muted">({text.length.toLocaleString()} chars)</span>
                  </summary>
                  <pre className="mt-1 max-h-80 overflow-auto rounded-md bg-sunken p-2 text-xs whitespace-pre-wrap">{text}</pre>
                </details>
              ) : (
                <span className="wrap-break-word">{text}</span>
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function CallDetails({ c }: { c: CallFull }) {
  const contactName = (c.contact?.name as string | undefined) ?? (c.meta_data?.name as string | undefined);
  return (
    <Card title="Call details">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        <Field label="Status">{STATUS_LABEL[c.status] ?? humanize(c.status)}</Field>
        <Field label="Direction">{c.call_type ? humanize(c.call_type) : null}</Field>
        <Field label="Agent">
          {c.agent_label ?? (c.agent_id ? `Agent ${c.agent_id}` : null)}
          {c.agent_id ? <span className="text-muted"> · id {c.agent_id}</span> : null}
        </Field>
        <Field label="Business">{c.business_id}</Field>
        <Field label="Contact">{contactName}</Field>
        <Field label="Phone (dialled / called)">{c.phone_number}</Field>
        <Field label="Phone (caller / from)">{c.source_phone_number}</Field>
        <Field label="Prompt">{c.prompt_code}</Field>
        <Field label="Channel">{c.channel}</Field>
        <Field label="Voice">{c.voice}</Field>
        <Field label="Telephony / voice provider">{[c.provider, c.voice_provider].filter(Boolean).join(" / ") || null}</Field>
        <Field label="Provider call id">{c.provider_call_id}</Field>
        <Field label="Playground call">{c.is_playground ? "Yes" : "No"}</Field>
        <Field label="Created">{formatDate(c.call_created_at)}</Field>
        <Field label="Scheduled">{c.scheduled_at ? formatDate(c.scheduled_at) : null}</Field>
        <Field label="Dialled">{c.initiated_at ? formatDate(c.initiated_at) : null}</Field>
        <Field label="Picked up">{c.picked_at ? formatDate(c.picked_at) : null}</Field>
        <Field label="Ended">{c.ends_at ? formatDate(c.ends_at) : null}</Field>
        <Field label="Duration">{formatDuration(c.duration)}</Field>
        <Field label="Ended because">{c.ended_reason ? humanize(c.ended_reason) : null}</Field>
        <Field label="Attempts">{c.retries !== null && c.retries !== undefined ? c.retries + 1 : null}</Field>
        <Field label="Reference">{c.system_ref_id}</Field>
        <Field label="Conversation">{c.conversation_ref}</Field>
        <Field label="Tags">{c.tags.length ? c.tags.join(", ") : null}</Field>
      </dl>

      {c.error_detail && (
        <div className="mt-4">
          <div className="mb-1 text-xs text-muted">Error detail</div>
          <Tree value={c.error_detail} />
        </div>
      )}
      {c.summary && (
        <div className="mt-4">
          <div className="mb-1 text-xs text-muted">Summary saved with the call</div>
          <p className="text-sm text-ink-2">{c.summary}</p>
        </div>
      )}
      {c.outcome && Object.keys(c.outcome).length > 0 && (
        <div className="mt-4">
          <div className="mb-1 text-xs text-muted">Recorded outcome</div>
          <Tree value={c.outcome} />
        </div>
      )}
      {Object.keys(c.variables).length > 0 && (
        <div className="mt-4">
          <div className="mb-1 text-xs text-muted">Call variables</div>
          <Variables value={c.variables} />
        </div>
      )}
      {c.meta_data && Object.keys(c.meta_data).length > 0 && (
        <div className="mt-4">
          <div className="mb-1 text-xs text-muted">Metadata</div>
          <Tree value={c.meta_data} />
        </div>
      )}
    </Card>
  );
}

function Scorecard({ r, onJump }: { r: AuditResult; onJump: (turn: number) => void }) {
  const rank = (k: string) => (SCORECARD_ORDER.includes(k) ? SCORECARD_ORDER.indexOf(k) : SCORECARD_ORDER.length);
  const rows = Object.entries(r.metrics).sort(([a], [b]) => rank(a) - rank(b));
  const applicable = rows.filter(([, m]) => m.applicable && m.score !== null);
  const earned = applicable.reduce((s, [, m]) => s + (m.score ?? 0), 0);
  const available = applicable.reduce((s, [, m]) => s + m.max, 0);
  return (
    <Card
      title="Scorecard"
      action={
        <span className="text-xs text-muted tabular">
          {earned} / {available} points{applicable.length < rows.length ? ` · ${rows.length - applicable.length} not applicable` : ""}
        </span>
      }
    >
      <ul className="flex flex-col gap-4">
        {rows.map(([key, m]) => (
          <li key={key}>
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="font-medium text-ink">{m.label ?? humanize(key)}</span>
              <span className="font-semibold text-ink tabular">{m.applicable && m.score !== null ? `${m.score} / ${m.max}` : "N/A"}</span>
            </div>
            <div className="mt-1.5">
              <Meter score={m.applicable ? m.score : null} max={m.max} />
            </div>
            <details className="mt-1.5">
              <summary className="cursor-pointer text-xs text-muted hover:text-ink">Why this score</summary>
              <p className="mt-1 text-sm text-ink-2">{m.reasoning}</p>
              {m.evidence.map((e, i) => (
                <TurnLink key={i} e={e} onJump={onJump} />
              ))}
            </details>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function AuditSections({ r, onJump }: { r: AuditResult; onJump: (turn: number) => void }) {
  return (
    <>
      <Card title="Call summary">
        <p className="text-sm text-ink">{r.call_summary}</p>
        <p className="mt-2 text-xs text-muted">
          Goal: {r.call_goal.explanation}
          {r.sentiment.note && ` · Sentiment: ${r.sentiment.note}`}
        </p>
      </Card>

      {r.call_success.failure_reasons.length > 0 && (
        <Card title="Why this call failed">
          <ul className="flex flex-col gap-3">
            {r.call_success.failure_reasons.map((f, i) => (
              <li key={i} className="text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="critical" icon={XCircle}>
                    {humanize(f.code)}
                  </Badge>
                  <span className="text-xs text-muted">{f.source === "rule" ? "rule check" : "LLM judge"}</span>
                </div>
                <p className="mt-1 text-ink-2">{f.explanation}</p>
                {failureEvidence(f).map((e, j) => (
                  <TurnLink key={j} e={e} onJump={onJump} />
                ))}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Scorecard r={r} onJump={onJump} />

      <Card title={`What the agent did well · ${r.went_well.length}`}>
        {r.went_well.length === 0 ? (
          <p className="text-sm text-muted">Nothing notable.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {r.went_well.map((w, i) => (
              <li key={i}>
                <div className="flex items-start gap-1.5 text-sm text-ink">
                  <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-good" aria-hidden />
                  {w.point}
                </div>
                <TurnLink e={w} onJump={onJump} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={`What can be improved · ${r.improvements.length}`}>
        {r.improvements.length === 0 ? (
          <p className="text-sm text-muted">Nothing to improve on this call.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {r.improvements.map((w, i) => (
              <li key={i}>
                <div className="flex items-start gap-1.5 text-sm text-ink">
                  <AlertTriangle size={15} className={`mt-0.5 shrink-0 ${SEVERITY_ICON[w.severity]}`} aria-hidden />
                  <span>
                    {w.point} <span className="text-xs text-muted">· {w.severity}</span>
                  </span>
                </div>
                <p className="mt-1 ml-5.25 text-sm text-ink-2">
                  <span className="font-medium text-ink">Instead: </span>
                  {w.suggestion}
                </p>
                <TurnLink e={w} onJump={onJump} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Conclusion">
        <p className="text-sm text-ink">{r.conclusion}</p>
        {!r.judge.prompt_used && (
          <p className="mt-2 text-xs text-muted">Graded without the agent's full instructions, so only facts contradicting the call data could be checked.</p>
        )}
      </Card>
    </>
  );
}

function Headline({ r }: { r: AuditResult }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <div className="rounded-xl border border-line bg-surface px-4 py-3">
        <div className="text-xs text-muted">Overall score</div>
        <div className="mt-1 text-4xl font-semibold text-ink">{r.overall_score ?? "—"}</div>
        <div className="mt-0.5 text-xs text-muted">
          {r.call_success.result === "FAIL" && r.quality_score !== null && r.quality_score !== r.overall_score
            ? `Capped by failure (scorecard ${r.quality_score})`
            : "out of 100"}
        </div>
      </div>
      <div className="rounded-xl border border-line bg-surface px-4 py-3">
        <div className="text-xs text-muted">Call success</div>
        <div className="mt-2">
          <SuccessBadge result={r.call_success.result} />
        </div>
        <div className="mt-1.5 text-xs text-ink-2">
          {r.call_success.failure_reasons.length === 0 ? "No failure conditions" : r.call_success.failure_reasons.map((f) => humanize(f.code)).join(", ")}
        </div>
      </div>
      <div className="rounded-xl border border-line bg-surface px-4 py-3">
        <div className="text-xs text-muted">Call goal</div>
        <div className="mt-2">
          <GoalBadge result={r.call_goal.result} />
        </div>
        <div className="mt-1.5 text-xs text-ink-2">{humanize(r.call_goal.reason_code)}</div>
      </div>
      <div className="rounded-xl border border-line bg-surface px-4 py-3">
        <div className="text-xs text-muted">Auditor confidence</div>
        <div className="mt-1 text-2xl font-semibold text-ink tabular">{Math.round(r.auditor_confidence * 100)}%</div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {r.needs_review && <ReviewBadge />}
          <span className="text-xs text-ink-2">
            Sentiment {r.sentiment.start} <ArrowRight size={11} className="inline" /> {r.sentiment.end}
          </span>
        </div>
      </div>
    </div>
  );
}

export function CallDetail({ id }: { id: number }) {
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ["call", id], queryFn: () => callsApi.get(id) });
  const runAudit = useMutation({
    mutationFn: () => callsApi.audit(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["call", id] });
      qc.invalidateQueries({ queryKey: ["calls"] });
      qc.invalidateQueries({ queryKey: ["call-stats"] });
    },
  });
  const [active, setActive] = useState<number | null>(null);
  const jump = (turn: number) => {
    setActive(null);
    // reset first so clicking the same turn twice scrolls again
    setTimeout(() => setActive(turn), 0);
  };

  if (detail.isLoading) return <p className="text-sm text-muted">Loading…</p>;
  if (detail.isError || !detail.data) return <p className="text-sm text-ink">Could not load this call: {(detail.error as Error)?.message}</p>;

  const { call: c, audit: a } = detail.data;
  const r = a?.status === "completed" ? a.result : null;
  const auditable = c.status === "completed" && c.transcript.length > 0;
  const cited = new Set<number>(
    r
      ? [
          ...r.went_well.map((w) => w.turn),
          ...r.improvements.map((w) => w.turn),
          ...r.call_success.failure_reasons.flatMap((f) => failureEvidence(f).map((e) => e.turn)),
        ]
      : [],
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <a href="#/" className="text-sm text-muted hover:text-ink">
            ← All calls
          </a>
          <h1 className="mt-1 text-xl font-semibold text-ink">Call #{c.call_id}</h1>
          <p className="mt-0.5 wrap-break-word text-sm text-muted">
            {c.agent_label ?? "Unknown agent"} · {c.call_type ?? "call"} · {STATUS_LABEL[c.status] ?? humanize(c.status)} · {formatDate(c.call_created_at)} ·{" "}
            {formatDuration(c.duration)}
            {r ? ` · rubric ${r.rubric_version}` : ""}
          </p>
        </div>
        {auditable && (
          <div className="flex flex-col items-end gap-1">
            <button
              onClick={() => runAudit.mutate()}
              disabled={runAudit.isPending}
              className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm disabled:opacity-50 ${
                a ? "border border-line bg-surface text-ink hover:bg-sunken" : "bg-accent font-medium text-white"
              }`}
            >
              {a ? <RefreshCw size={14} className={runAudit.isPending ? "animate-spin" : ""} /> : <Play size={14} />}
              {runAudit.isPending ? "Auditing… (about 15 s)" : a ? "Re-audit" : "Audit this call"}
            </button>
            {runAudit.isError && <span className="text-xs text-ink">⚠ {(runAudit.error as Error).message}</span>}
          </div>
        )}
      </div>

      {r ? (
        <Headline r={r} />
      ) : (
        <Card>
          <div className="flex flex-col gap-2 text-sm">
            {a && a.status !== "completed" ? (
              <>
                <StatusBadge status={a.status} reason={a.skip_reason} />
                {a.status === "failed" && <p className="text-ink-2">The auditor could not grade this call: {a.error}</p>}
              </>
            ) : auditable ? (
              <p className="text-ink-2">This call hasn't been audited yet. Use “Audit this call” to grade it now.</p>
            ) : (
              <p className="text-ink-2">
                Nothing to audit:{" "}
                {c.status !== "completed" ? `the call was never completed (${STATUS_LABEL[c.status] ?? humanize(c.status)})` : "there is no transcript"}.
              </p>
            )}
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          {r && <AuditSections r={r} onJump={jump} />}
          <CallDetails c={c} />
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Card title="Recording">
            <Recording id={c.call_id} hasRecording={Boolean(c.recording_url)} />
          </Card>
          <Card title={`Transcript · ${c.transcript.length} turns`}>
            <Transcript turns={c.transcript} active={active} cited={cited} />
          </Card>
          {r && a && (
            <p className="text-xs text-muted">
              Judged by {r.judge.model}
              {r.judge.prompt_used ? ` against prompt ${r.judge.prompt_used.prompt_code} v${r.judge.prompt_used.version}` : ""} · rubric {r.rubric_version} ·
              transcript {r.judge.transcript_quality} · {Math.round(r.judge.evidence_validity * 100)}% of quotes verified · audited {formatDate(a.audited_at)}
              {a.latency_ms ? ` in ${(a.latency_ms / 1000).toFixed(1)}s` : ""}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, CheckCircle2, RefreshCw, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type AuditDetail, type AuditResult, type Evidence, type Turn } from "../api";
import {
  Badge,
  Card,
  formatDate,
  formatDuration,
  GoalBadge,
  humanize,
  Meter,
  ReviewBadge,
  StatusBadge,
  SuccessBadge,
} from "../components/ui";

const SEVERITY_ICON = { high: "text-critical", medium: "text-serious", low: "text-warning" } as const;

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
        “{e.quote}”
        {e.valid === false && <span className="ml-1 text-xs text-muted">(quote not found in transcript)</span>}
      </span>
    </button>
  );
}

function Transcript({ turns, active, cited }: { turns: Turn[]; active: number | null; cited: Set<number> }) {
  const refs = useRef(new Map<number, HTMLDivElement>());
  useEffect(() => {
    if (active !== null) refs.current.get(active)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [active]);

  if (turns.length === 0) return <p className="text-sm text-muted">No transcript.</p>;
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
          <span className="text-xs text-muted tabular pt-0.5">{t.turn}</span>
          <span className={`text-xs pt-0.5 font-medium ${t.speaker === "agent" ? "text-accent" : "text-ink-2"}`}>
            {t.speaker === "agent" ? "Agent" : t.speaker === "user" ? "Caller" : humanize(t.speaker)}
          </span>
          <span className="text-ink">{t.text}</span>
        </div>
      ))}
    </div>
  );
}

function Recording({ id }: { id: number }) {
  const rec = useQuery({ queryKey: ["recording", id], queryFn: () => api.recording(id), staleTime: 30 * 60_000 });
  if (rec.isLoading) return <p className="text-sm text-muted">Loading recording…</p>;
  if (!rec.data?.url) return <p className="text-sm text-muted">Recording unavailable{rec.data?.reason ? ` — ${rec.data.reason}` : ""}.</p>;
  return <audio controls preload="none" src={rec.data.url} className="w-full" />;
}

function Header({ a }: { a: AuditDetail }) {
  const qc = useQueryClient();
  const reaudit = useMutation({
    mutationFn: () => api.reaudit(a.id),
    onSuccess: (data) => {
      qc.setQueryData(["audit", a.id], data);
      qc.invalidateQueries({ queryKey: ["audits"] });
      qc.invalidateQueries({ queryKey: ["stats"] });
    },
  });
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <a href="#/" className="text-sm text-muted hover:text-ink">
          ← All calls
        </a>
        <h1 className="mt-1 text-xl font-semibold text-ink">Call #{a.call_id}</h1>
        <p className="mt-0.5 text-sm text-muted break-words">
          {a.result?.agent_label ?? a.agent_code ?? "Unknown agent"} · {a.call.call_type ?? "call"} · {formatDate(a.call.call_created_at)} · {formatDuration(a.call.duration)} · ended:{" "}
          {a.call.ended_reason ?? "—"} · rubric {a.rubric_version}
        </p>
      </div>
      <div className="flex flex-col items-end gap-1">
        <button
          onClick={() => reaudit.mutate()}
          disabled={reaudit.isPending}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface px-3 text-sm text-ink hover:bg-sunken disabled:opacity-50"
        >
          <RefreshCw size={14} className={reaudit.isPending ? "animate-spin" : ""} /> {reaudit.isPending ? "Re-auditing…" : "Re-audit"}
        </button>
        {reaudit.isError && <span className="text-xs text-ink">⚠ {(reaudit.error as Error).message}</span>}
      </div>
    </div>
  );
}

// JSONB does not keep key order, so categories are always shown in scorecard order.
const SCORECARD_ORDER = ["opening", "communication", "troubleshooting", "query_handling", "closure"];

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

export function CallDetail({ id }: { id: number }) {
  const audit = useQuery({ queryKey: ["audit", id], queryFn: () => api.get(id) });
  const [active, setActive] = useState<number | null>(null);
  const jump = (turn: number) => {
    setActive(null);
    // reset first so clicking the same turn twice scrolls again
    setTimeout(() => setActive(turn), 0);
  };

  if (audit.isLoading) return <p className="text-sm text-muted">Loading…</p>;
  if (audit.isError || !audit.data) return <p className="text-sm text-ink">Could not load this audit: {(audit.error as Error)?.message}</p>;

  const a = audit.data;
  const r = a.result;
  const cited = new Set<number>(
    r
      ? [
          ...r.went_well.map((w) => w.turn),
          ...r.improvements.map((w) => w.turn),
          ...r.call_success.failure_reasons.flatMap((f) => (f.turn ? [f.turn] : [])),
        ]
      : [],
  );

  return (
    <div className="flex flex-col gap-4">
      <Header a={a} />

      {a.status !== "completed" || !r ? (
        <Card>
          <div className="flex flex-col gap-2 text-sm">
            <StatusBadge status={a.status} reason={a.skip_reason} />
            {a.status === "failed" && <p className="text-ink-2">The auditor could not grade this call: {a.error}</p>}
            {a.status === "skipped" && <p className="text-ink-2">Nothing to grade for this call ({humanize(a.skip_reason ?? "")}).</p>}
          </div>
        </Card>
      ) : (
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
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          {r && (
            <Card title="Call summary">
              <p className="text-sm text-ink">{r.call_summary}</p>
              <p className="mt-2 text-xs text-muted">
                Goal: {r.call_goal.explanation}
                {r.sentiment.note && ` · Sentiment: ${r.sentiment.note}`}
              </p>
            </Card>
          )}

          {r && r.call_success.failure_reasons.length > 0 && (
            <Card title="Failure reasons">
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
                    {f.turn !== null && f.quote && <TurnLink e={{ turn: f.turn, quote: f.quote, valid: (f as Evidence).valid }} onJump={jump} />}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {r && <Scorecard r={r} onJump={jump} />}

          {r && (
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
                      <TurnLink e={w} onJump={jump} />
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}

          {r && (
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
                      <p className="mt-1 ml-[21px] text-sm text-ink-2">
                        <span className="font-medium text-ink">Instead: </span>
                        {w.suggestion}
                      </p>
                      <TurnLink e={w} onJump={jump} />
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}

          {r && (
            <Card title="Conclusion">
              <p className="text-sm text-ink">{r.conclusion}</p>
              {!r.judge.prompt_used && (
                <p className="mt-2 text-xs text-muted">Graded without the agent's instructions, so invented facts could not be checked against them.</p>
              )}
            </Card>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Card title="Recording">
            <Recording id={a.id} />
          </Card>
          <Card title={`Transcript · ${a.call.transcript.length} turns`}>
            <Transcript turns={a.call.transcript} active={active} cited={cited} />
          </Card>
          {(a.call.summary || a.call.outcome) && (
            <Card title="Call record">
              {a.call.summary && (
                <>
                  <div className="text-xs text-muted">Summary saved with the call</div>
                  <p className="mt-1 text-sm text-ink-2">{a.call.summary}</p>
                </>
              )}
              {a.call.outcome && Object.keys(a.call.outcome).length > 0 && (
                <>
                  <div className="mt-3 text-xs text-muted">Recorded outcome</div>
                  <Outcome value={a.call.outcome} />
                </>
              )}
            </Card>
          )}
          {r && (
            <p className="text-xs text-muted">
              Judged by {r.judge.model}
              {r.judge.prompt_used ? ` against prompt ${r.judge.prompt_used.prompt_code} v${r.judge.prompt_used.version}` : ""} · rubric{" "}
              {r.rubric_version} · transcript {r.judge.transcript_quality} · {Math.round(r.judge.evidence_validity * 100)}% of quotes verified ·
              audited {formatDate(a.audited_at)}
              {a.latency_ms ? ` in ${(a.latency_ms / 1000).toFixed(1)}s` : ""}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/** Outcome values can be nested objects (e.g. a tool's result); show them as a readable tree. */
function Outcome({ value }: { value: Record<string, unknown> }) {
  return (
    <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      {Object.entries(value).map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{humanize(k)}</dt>
          <dd className="min-w-0 text-ink">
            {v !== null && typeof v === "object" ? (
              <div className="border-l border-line pl-3">
                <Outcome value={v as Record<string, unknown>} />
              </div>
            ) : (
              <span className="break-words">{String(v)}</span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

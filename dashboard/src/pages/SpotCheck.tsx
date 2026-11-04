import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ChevronLeft, ChevronRight, Circle } from "lucide-react";
import { startTransition, useEffect, useRef, useState, ViewTransition } from "react";
import { api, spotCheckApi, type BlindItem, type WeekSample } from "../api";
import { Button, Card, ErrorNote, formatDate, formatDuration, humanize, Skeleton } from "../components/ui";
import { BlindForm, BlindReveal } from "../components/v2/blind-form";
import { Transcript, TranscriptProvider } from "../components/v2/evidence";
import { Recording } from "./CallDetail";

/**
 * Blind spot-checks (P2-18, PRD §8 #2, §9). `#/spot-check?week=` lists the week's random sample; `#/spot-check/:id`
 * is one call: transcript and recording, the reviewer's answer, then the judge's beside it. Only audits that already
 * exist are sampled; nothing here starts one.
 */

const DAY = 86_400_000;
const shiftWeek = (week: string, by: number) => new Date(new Date(`${week}T00:00:00Z`).getTime() + by * 7 * DAY).toISOString().slice(0, 10);
const weekLabel = (week: string) => {
  const from = new Date(`${week}T00:00:00Z`);
  const to = new Date(from.getTime() + 6 * DAY);
  const f = (d: Date) => d.toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
  return `${f(from)} – ${f(to)}`;
};

function useAgentLabels() {
  const agents = useQuery({ queryKey: ["agents"], queryFn: api.agents, staleTime: Infinity });
  return (code: string | null) => (code ? (agents.data?.agents.find((a) => a.code === code)?.label ?? humanize(code)) : "Unknown agent");
}

/** The first unchecked call in the week's sample after `after`, for *Next call*. */
export const nextUnchecked = (sample: WeekSample | undefined, after: number) => {
  const items = sample?.agents.flatMap((a) => a.items) ?? [];
  return items.find((i) => !i.done && i.audit_id !== after)?.audit_id ?? null;
};

export function SpotCheckList({ week }: { week?: string }) {
  const qc = useQueryClient();
  const label = useAgentLabels();
  const sample = useQuery({ queryKey: ["spot-check", week ?? "current"], queryFn: () => spotCheckApi.week(week) });
  const topUp = useMutation({
    mutationFn: () => spotCheckApi.topUp(sample.data!.week_start),
    onSuccess: (data) => qc.setQueryData(["spot-check", week ?? "current"], data),
  });
  const s = sample.data;
  const total = s?.agents.reduce((n, a) => n + a.items.length, 0) ?? 0;
  const done = s?.agents.reduce((n, a) => n + a.items.filter((i) => i.done).length, 0) ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-ink">Spot-checks</h1>
          <div className="mt-0.5 text-sm text-muted">
            {s ? `${weekLabel(s.week_start)} · ${done} of ${total} checked` : <Skeleton className="inline-block h-4 w-48 align-middle" />}
          </div>
        </div>
        {s && (
          <div className="flex items-center gap-1">
            <a href={`#/spot-check?week=${shiftWeek(s.week_start, -1)}`} className="btn btn-ghost btn-compact" aria-label="Previous week">
              <ChevronLeft size={16} aria-hidden />
            </a>
            <a href={`#/spot-check?week=${shiftWeek(s.week_start, 1)}`} className="btn btn-ghost btn-compact" aria-label="Next week">
              <ChevronRight size={16} aria-hidden />
            </a>
          </div>
        )}
      </div>

      <p className="max-w-3xl text-sm text-ink-2">
        Grade each call before you see the judge's answer: should it pass, what was the business outcome, and which failure conditions
        happened? About 2 minutes a call. Calls are drawn at random, {s?.per_agent ?? 5} per agent a week, from calls already audited with
        v2.
      </p>

      {sample.isPending ? (
        <Card>
          <Skeleton className="h-24 w-full" />
        </Card>
      ) : sample.isError ? (
        <Card>
          <ErrorNote>Couldn't load this week's spot-checks: {(sample.error as Error).message}</ErrorNote>
        </Card>
      ) : (
        <>
          {s!.shortfall.length > 0 && (
            <div
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-sunken px-3 py-2 text-sm text-ink-2"
              role="status"
            >
              <span>
                Not enough audited calls this week:{" "}
                {s!.shortfall.map((f) => `${label(f.agent_code)} ${f.available} of ${f.wanted}`).join(", ")}. Audit more of this week's
                calls, then top up.
              </span>
              {s!.can_top_up > 0 && (
                <Button compact onClick={() => topUp.mutate()} disabled={topUp.isPending}>
                  {topUp.isPending ? "Adding…" : `Add ${s!.can_top_up} new ${s!.can_top_up === 1 ? "call" : "calls"}`}
                </Button>
              )}
            </div>
          )}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {s!.agents.map((a) => (
              <Card
                key={a.agent_code}
                title={label(a.agent_code)}
                action={
                  a.items.length > 0 && (
                    <span className="text-xs text-muted tabular">
                      {a.items.filter((i) => i.done).length} of {a.items.length} checked
                    </span>
                  )
                }
              >
                {a.items.length === 0 ? (
                  <p className="text-sm text-muted">No audited calls this week.</p>
                ) : (
                  <ul className="flex flex-col divide-y divide-line">
                    {a.items.map((i) => (
                      <li key={i.audit_id}>
                        <a
                          href={`#/spot-check/${i.audit_id}`}
                          className="flex min-h-11 items-center justify-between gap-3 rounded-md px-1 py-2 text-sm transition-colors duration-(--motion-fast) hover:bg-sunken"
                        >
                          <span className="flex items-center gap-2">
                            {i.done ? (
                              <CheckCircle2 size={15} className="text-good" aria-hidden />
                            ) : (
                              <Circle size={15} className="text-muted" aria-hidden />
                            )}
                            <span className="font-medium text-ink tabular">Call #{i.call_id}</span>
                            <span className="text-xs text-muted">
                              {formatDate(i.call_created_at)} · {formatDuration(i.duration)}
                            </span>
                          </span>
                          <span className="text-xs text-muted">{i.done ? "Checked" : "To check"}</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            ))}
          </div>
          {topUp.isError && <ErrorNote>{(topUp.error as Error).message}</ErrorNote>}
        </>
      )}
    </div>
  );
}

export function SpotCheckItem({ auditId }: { auditId: number }) {
  const qc = useQueryClient();
  const label = useAgentLabels();
  const item = useQuery({ queryKey: ["spot-check-item", auditId], queryFn: () => spotCheckApi.item(auditId) });
  const sample = useQuery({ queryKey: ["spot-check", "current"], queryFn: () => spotCheckApi.week() });
  const [saved, setSaved] = useState<BlindItem | null>(null);
  const save = useMutation({
    mutationFn: (answer: Parameters<typeof spotCheckApi.save>[1]) => spotCheckApi.save(auditId, answer),
    onSuccess: (data) => {
      // The reveal is a transition, so <ViewTransition> animates the judge's answer in.
      startTransition(() => setSaved(data));
      qc.invalidateQueries({ queryKey: ["spot-check"] });
      qc.setQueryData(["spot-check-item", auditId], data);
    },
  });
  const it = saved ?? item.data;
  // After saving, the long form gives way to a short reveal; bring its top into view if the reader was scrolled past it.
  const answerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = answerRef.current;
    if (!saved || !el || el.getBoundingClientRect().top >= 0) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  }, [saved]);

  return (
    <TranscriptProvider>
      <div className="flex flex-col gap-4">
        <div>
          <a href="#/spot-check" className="text-sm text-muted hover:text-ink">
            ← This week's checks
          </a>
          <h1 className="mt-1 text-xl font-semibold text-ink">Spot-check · Call #{it?.call_id ?? "…"}</h1>
          <p className="mt-0.5 text-sm text-muted">
            {it
              ? `${label(it.agent_code)} · ${it.call.call_type ?? "call"} · ${formatDate(it.call.call_created_at)} · ${formatDuration(it.call.duration)}`
              : "Loading…"}
          </p>
        </div>
        {item.isError ? (
          <Card>
            <ErrorNote>Couldn't load this spot-check: {(item.error as Error).message}</ErrorNote>
          </Card>
        ) : (
          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
            <div ref={answerRef} className="min-w-0 scroll-mt-4">
              <Card title={it?.revealed ? "Your answer and the judge's" : "Your answer"}>
                {!it ? (
                  <Skeleton className="h-64 w-full" />
                ) : it.revealed ? (
                  <ViewTransition enter="verdict-reveal" default="none">
                    <BlindReveal item={it} next={nextUnchecked(sample.data, auditId)} />
                  </ViewTransition>
                ) : (
                  <BlindForm
                    options={it.options}
                    saving={save.isPending}
                    error={save.error ? (save.error as Error).message : null}
                    onSave={(a) => save.mutate(a)}
                  />
                )}
              </Card>
            </div>
            <div className="flex min-w-0 flex-col gap-4">
              <Card title="Recording">
                {it ? <Recording id={it.call_id} hasRecording={it.call.has_recording} /> : <Skeleton className="h-8 w-full" />}
              </Card>
              <Card title={it ? `Transcript · ${it.call.transcript.length} turns` : "Transcript"}>
                {it ? <Transcript turns={it.call.transcript} /> : <Skeleton className="h-40 w-full" />}
              </Card>
            </div>
          </div>
        )}
      </div>
    </TranscriptProvider>
  );
}

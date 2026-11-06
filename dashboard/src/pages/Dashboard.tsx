import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { AlertTriangle, CalendarDays, Download, SlidersHorizontal } from "lucide-react";
import { type ReactNode, useState } from "react";
import { type Dashboard as DashboardData, type DashboardFilters, type DashboardMode, dashboardApi } from "../api";
import { AgentTable, FailureList, GoalFunnel, MetricHeatmap, OutcomeBuckets, ScoreHistogram, TrendChart } from "../components/dashboard/charts";
import { Button, EmptyState, ErrorNote, Popover, Segmented, Skeleton, Switch, Tip } from "../components/ui";
import { KPIS, callsHref, dashboardCsv, dashboardHref, downloadCsv, fmtCount, fmtPct, kpiDelta, kpiValue, shortDay } from "../lib/dashboard";

/*
 * System dashboard (PRD §6; P2-7 – P2-9): "are calls getting better, and if not, why?"
 * Layout (dashboard-design): header with range and filters → KPI strip → trend | histogram → failure causes | outcome
 * buckets → funnel | heatmap → agent table. Everything comes from one request (`GET /v2/dashboard`, built from the daily
 * roll-ups), so there is no request waterfall; filters live in the URL so a view can be shared.
 * Left out of the mockup on purpose: sentiment (not in §6, no data) and the insight/recommendation sentences (the
 * problem is flagged where it is: a red delta, a warm heatmap cell, the attention bins).
 */

const PRESETS: [string, number][] = [
  ["Today", 1],
  ["Last 7 days", 7],
  ["Last 30 days", 30],
  ["Last 90 days", 90],
];

const istToday = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const shift = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export function Dashboard({ search }: { search: string }) {
  const filters = Object.fromEntries(new URLSearchParams(search)) as DashboardFilters;
  const set = (patch: DashboardFilters) => {
    const next = { ...filters, ...patch };
    for (const k of Object.keys(next) as (keyof DashboardFilters)[]) if (!next[k]) delete next[k];
    window.location.hash = dashboardHref(next).slice(1);
  };
  const q = useQuery({ queryKey: ["dashboard", filters], queryFn: () => dashboardApi.get(filters), placeholderData: keepPreviousData, staleTime: 60_000 });
  const d = q.data;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[22px] leading-7 font-medium tracking-[-0.01em] text-ink">System dashboard</h1>
          <p className="mt-1 text-sm text-ink-2">Are calls getting better, and if not, why</p>
        </div>
        {d && <Toolbar key={`${d.filters.from}|${d.filters.to}`} d={d} set={set} />}
      </header>

      {q.isError && !d ? (
        <ErrorNote>The dashboard didn't load: {(q.error as Error).message}</ErrorNote>
      ) : !d ? (
        <Loading />
      ) : (
        <div className={`flex flex-col gap-5 transition-opacity duration-200 ease-snap ${q.isPlaceholderData ? "opacity-60" : ""}`} aria-busy={q.isFetching}>
          <SampleNote d={d} />
          <KpiStrip d={d} />
          <div className="grid gap-5 lg:grid-cols-[3fr_2fr]">
            <Panel title="Pass rate and goals" sub={d.bucket === "week" ? "per week" : "per day"}>
              <TrendChart d={d} />
            </Panel>
            <Panel title="Score distribution" sub={`${fmtCount(d.histogram.scored)} scored calls`}>
              <ScoreHistogram d={d} />
            </Panel>
          </div>
          <div className="grid gap-5 lg:grid-cols-2">
            <Panel title="Top failure causes" sub="calls affected">
              <FailureList d={d} />
            </Panel>
            <Panel title="Outcome buckets" sub="system goal × business goal">
              <OutcomeBuckets d={d} />
            </Panel>
          </div>
          <div className="grid gap-5 xl:grid-cols-[2fr_3fr]">
            <Panel title="Business goal funnel">
              <GoalFunnel d={d} />
            </Panel>
            <Panel title="Metric heatmap" sub="average % per agent">
              <MetricHeatmap d={d} />
            </Panel>
          </div>
          <Panel title="Agents">
            <AgentTable d={d} onAgent={(agent) => set({ agent })} />
          </Panel>
          <p className="text-xs text-muted">
            Days are IST, by when the call was made. Call counts refresh nightly at 02:00 IST
            {d.calls_refreshed_at ? `; last ${new Date(d.calls_refreshed_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : ""}. Audit
            numbers update as audits finish.
          </p>
        </div>
      )}
    </div>
  );
}

function Panel({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="min-w-0 rounded-xl bg-surface p-5 shadow-card">
      <h2 className="mb-4 text-base font-medium text-ink">
        {title}
        {sub && <span className="ml-2 text-xs font-normal text-muted">{sub}</span>}
      </h2>
      {children}
    </section>
  );
}

function Loading() {
  return (
    <div className="flex flex-col gap-5" aria-label="Loading the dashboard">
      <Skeleton className="h-28 rounded-xl" />
      <div className="grid gap-5 lg:grid-cols-[3fr_2fr]">
        <Skeleton className="h-72 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Skeleton className="h-64 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    </div>
  );
}

/** Range, agent, more filters, compare, as audited / re-scored, export: one row that wraps on phones. */
function Toolbar({ d, set }: { d: DashboardData; set: (p: DashboardFilters) => void }) {
  const f = d.filters;
  const [from, setFrom] = useState(f.from);
  const [to, setTo] = useState(f.to);
  const moreCount = [f.direction, f.goal, f.scorecard].filter(Boolean).length;
  const rangeLabel = f.from === f.to ? shortDay(f.from) : `${shortDay(f.from)} – ${shortDay(f.to)}`;
  const select = "h-9 w-full rounded-full border border-control bg-surface px-3 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Popover
        label={
          <>
            <CalendarDays size={15} aria-hidden /> {rangeLabel}
          </>
        }
        align="right"
        panelClassName="w-72"
      >
        {(close) => (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-1.5">
              {PRESETS.map(([label, days]) => (
                <button
                  key={label}
                  type="button"
                  className="rounded-full bg-sunken px-3 py-1.5 text-sm text-ink hover:bg-line-strong"
                  onClick={() => {
                    const today = istToday();
                    set({ from: shift(today, 1 - days), to: today });
                    close();
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (from && to && from <= to) {
                  set({ from, to });
                  close();
                }
              }}
            >
              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1 text-xs text-muted">
                  From
                  <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className={select} />
                </label>
                <label className="flex flex-col gap-1 text-xs text-muted">
                  To
                  <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className={select} />
                </label>
              </div>
              <Button variant="primary" compact type="submit" disabled={!from || !to || from > to}>
                Show range
              </Button>
            </form>
          </div>
        )}
      </Popover>
      <label className="sr-only" htmlFor="dash-agent">
        Agent
      </label>
      <select id="dash-agent" value={f.agent ?? ""} onChange={(e) => set({ agent: e.target.value })} className="btn btn-secondary btn-compact pr-8">
        <option value="">All agents</option>
        {d.options.agents.map((a) => (
          <option key={a.code} value={a.code}>
            {a.label}
          </option>
        ))}
      </select>
      <Popover
        label={
          <>
            <SlidersHorizontal size={15} aria-hidden /> Filters{moreCount ? ` · ${moreCount}` : ""}
          </>
        }
        align="right"
        panelClassName="w-72"
      >
        {() => (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-xs text-muted">
              Direction
              <select value={f.direction ?? ""} onChange={(e) => set({ direction: e.target.value })} className={select}>
                <option value="">Inbound and outbound</option>
                <option value="inbound">Inbound</option>
                <option value="outbound">Outbound</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted">
              Business goal
              <select value={f.goal ?? ""} onChange={(e) => set({ goal: e.target.value })} className={select}>
                <option value="">Any goal</option>
                {d.options.goals.map((g) => (
                  <option key={g.key} value={g.key}>
                    {g.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted">
              Scorecard version
              <select value={f.scorecard ?? ""} onChange={(e) => set({ scorecard: e.target.value })} className={select}>
                <option value="">Any version</option>
                {d.options.scorecards.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            {(f.goal || f.scorecard) && <p className="text-xs text-muted">Call counts and connect rate can't be split by goal or scorecard; they follow agent and direction only.</p>}
          </div>
        )}
      </Popover>
      <span className="inline-flex h-8 items-center gap-2 rounded-full bg-sunken px-3 text-sm text-ink">
        <Switch id="dash-compare-switch" checked={f.compare} onChange={(on) => set({ compare: on ? "1" : "" })} aria-labelledby="dash-compare" />
        <label id="dash-compare" htmlFor="dash-compare-switch" className="cursor-pointer">
          Compare
        </label>
      </span>
      <Tip tip="Re-scored: every call scored again with its agent's current scorecard weights, from the stored metric scores. Goals don't change." side="bottom">
        <Segmented<DashboardMode>
          legend="Scores"
          value={f.mode}
          options={[
            ["as_audited", "As audited"],
            ["rescored", "Re-scored"],
          ]}
          onChange={(mode) => set({ mode: mode === "as_audited" ? undefined : mode })}
        />
      </Tip>
      <Button compact onClick={() => downloadCsv(`dashboard-${f.from}-to-${f.to}.csv`, dashboardCsv(d))}>
        <Download size={15} aria-hidden /> Export
      </Button>
    </div>
  );
}

/** How many audited calls back the numbers, and the warnings PRD §6 asks for. */
function SampleNote({ d }: { d: DashboardData }) {
  const { audited, hand_picked, low } = d.sample;
  if (audited === 0)
    return (
      <div className="rounded-xl bg-surface px-5 py-4 shadow-card">
        <EmptyState title="No audited calls in this range" action={<a href={callsHref(d.filters)} className="text-sm text-accent hover:underline">Open these calls</a>}>
          Call counts still show below. Audit calls from the Calls page and their quality numbers appear here.
        </EmptyState>
      </div>
    );
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <a href={callsHref(d.filters, { audit: "audited" })} className="rounded-full bg-sunken px-3 py-1 text-ink-2 hover:text-ink">
        Based on <span className="font-medium text-ink tabular">{fmtCount(audited)}</span> audited calls
        {d.filters.mode === "rescored" && " · re-scored"}
      </a>
      {low && (
        <span role="note" className="inline-flex items-center gap-1.5 rounded-full border border-warning/60 bg-warning-soft px-3 py-1 text-ink">
          <AlertTriangle size={14} className="text-warning" aria-hidden />
          Small sample: under 30 audited calls, so rates can swing a lot
        </span>
      )}
      {hand_picked > 0 && (
        <span role="note" className="inline-flex items-center gap-1.5 rounded-full border border-warning/60 bg-warning-soft px-3 py-1 text-ink">
          <AlertTriangle size={14} className="text-warning" aria-hidden />
          {hand_picked === audited ? "All" : `${fmtCount(hand_picked)} of ${fmtCount(audited)}`} audits were picked by hand, not drawn at random
        </span>
      )}
    </div>
  );
}

/** One card of KPI tiles divided by hairlines; each opens the calls behind it. */
function KpiStrip({ d }: { d: DashboardData }) {
  return (
    <section aria-label="Key numbers" className="grid grid-cols-2 overflow-hidden rounded-xl bg-surface shadow-card sm:grid-cols-4 xl:grid-cols-8">
      {KPIS.map((def) => {
        const k = d.kpis[def.key];
        const delta = kpiDelta(def, k);
        const partial = def.key === "business_goal_rate" ? d.kpis.partial_share.current : null;
        const small = def.kind !== "count" && k.current.den > 0 && k.current.den < 30 && def.key !== "connect_rate";
        return (
          <Tip key={def.key} className="border-line [&:not(:last-child)]:border-r [&:not(:last-child)]:border-b xl:[&:not(:last-child)]:border-b-0" tip={<span>{def.tip(k.current)}{k.previous ? ` · period before ${kpiValue(def, k.previous)}` : ""}{small ? " · small sample" : ""}</span>} side="bottom">
            <a href={callsHref(d.filters, def.link)} className="block w-full px-4 py-4 hover:bg-selected focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus">
              <span className="block text-[13px] text-ink-2">{def.label}</span>
              <span className="mt-1 flex items-baseline gap-2">
                <span className="text-[28px] leading-[34px] font-medium tracking-[-0.02em] text-ink tabular">{kpiValue(def, k.current)}</span>
                {partial && partial.value !== null && <span className="text-xs text-muted tabular">Partial {fmtPct(partial)}</span>}
              </span>
              <span className="mt-1 block h-4 text-xs tabular">
                {delta ? (
                  <span className={delta.tone === "good" ? "text-good-ink" : delta.tone === "bad" ? "text-critical" : "text-muted"}>
                    {delta.text}
                    {!delta.text.startsWith("was") && <span className="text-muted"> vs before</span>}
                  </span>
                ) : def.kind !== "count" && k.current.den > 0 ? (
                  <span className="text-muted">
                    {small ? "n = " : "of "}
                    {fmtCount(k.current.den)}
                  </span>
                ) : null}
              </span>
            </a>
          </Tip>
        );
      })}
    </section>
  );
}

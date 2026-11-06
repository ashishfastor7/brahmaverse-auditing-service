import { memo, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Dashboard, Rate } from "../../api";
import { BUCKETS, FUNNEL_LABELS, FUNNEL_TIPS, callsHref, fmtCount, fmtPct, fmtScore, humanize, shortDay } from "../../lib/dashboard";
import { EmptyState, Tip } from "../ui";

/*
 * System dashboard charts, hand-rolled SVG on the chart tokens (index.css: series-1…6, chart-grid/axis/muted).
 * Deviations from the dashboard-design / dataviz specs, on purpose:
 * - The trend has three series (pass, system goal, business goal) with a legend and direct end labels; no fill, as
 *   three filled areas would hide each other.
 * - The histogram marks failing bins (under the pass threshold) in the attention hue: that's the problem to see.
 * Every mark is a link to the calls behind it, so it's reachable by keyboard and its tooltip shows on focus too.
 */

/** Width of an element, kept current with a ResizeObserver (charts draw at real pixels, so text never stretches). */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** A dark tooltip card: the value large, the context in a muted line. */
function TipCard({ title, rows }: { title: string; rows: [string, ReactNode][] }) {
  return (
    <span className="block">
      <span className="block font-medium">{title}</span>
      {rows.map(([k, v]) => (
        <span key={k} className="flex justify-between gap-4 opacity-90">
          <span>{k}</span>
          <span className="tabular">{v}</span>
        </span>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------- Trend

const TREND = [
  { key: "pass_rate", label: "Pass rate", color: "var(--series-1)" },
  { key: "system_goal_rate", label: "System goal", color: "var(--series-2)" },
  { key: "business_goal_rate", label: "Business goal", color: "var(--series-3)" },
] as const;

/** Pass, system goal and business goal rate per day (or week), broken at scorecard version changes, with release markers. */
export const TrendChart = memo(function TrendChart({ d }: { d: Dashboard }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const H = 220;
  const pad = { l: 36, r: 64, t: 24, b: 26 };
  const n = d.trend.length;
  const w = Math.max(0, width - pad.l - pad.r);
  const x = (i: number) => pad.l + (n <= 1 ? w / 2 : (i * w) / (n - 1));
  const y = (v: number) => pad.t + (1 - v) * (H - pad.t - pad.b);

  const paths = useMemo(
    () =>
      TREND.map((s) => {
        let path = "";
        let pen = false;
        d.trend.forEach((p, i) => {
          const v = p[s.key].value;
          // A new scorecard version starts a new line (PRD §6: metric trends don't cross versions).
          const versionBreak = i > 0 && p.versions.join() !== d.trend[i - 1]!.versions.join() && d.trend[i - 1]!.versions.length > 0;
          if (v === null) {
            pen = false;
            return;
          }
          path += `${pen && !versionBreak ? "L" : "M"}${r1(x(i))},${r1(y(v))}`;
          pen = true;
        });
        const last = [...d.trend].reverse().find((p) => p[s.key].value !== null);
        return { ...s, path, last: last ? { i: d.trend.lastIndexOf(last), v: last[s.key].value! } : null };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [d.trend, width],
  );
  // End labels: pushed apart so two lines ending at the same value don't print on top of each other.
  const labels = paths
    .filter((s) => s.last)
    .map((s) => ({ key: s.key, color: s.color, x: x(s.last!.i) + 8, v: s.last!.v, ly: y(s.last!.v) }))
    .sort((a, b) => a.ly - b.ly);
  for (let i = 1; i < labels.length; i++) if (labels[i]!.ly - labels[i - 1]!.ly < 14) labels[i]!.ly = labels[i - 1]!.ly + 14;
  const step = Math.max(1, Math.ceil(n / 7));
  const markersAt = new Map<number, Dashboard["markers"]>();
  for (const m of d.markers) {
    const i = d.trend.findIndex((p) => p.bucket === m.bucket);
    if (i >= 0) markersAt.set(i, [...(markersAt.get(i) ?? []), m]);
  }
  const anyData = d.trend.some((p) => p.audited > 0);
  // With few audited points, every point gets a marker; otherwise only on hover and for lone points.
  const sparse = d.trend.filter((p) => p.audited > 0).length < 10;

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-2" aria-hidden>
        {TREND.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span className="h-0.5 w-3 rounded-full" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
        {markersAt.size > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <span className="h-3 border-l border-dashed border-ink-2" />
            Release
          </span>
        )}
      </div>
      <div ref={ref} className="relative" onMouseLeave={() => setHover(null)}>
        {!anyData ? (
          <EmptyState title="No audited calls in this range">Audit calls from the Calls page; their days appear here.</EmptyState>
        ) : width > 0 ? (
          <svg width={width} height={H} role="img" aria-label="Pass, system goal and business goal rate over time" className="block overflow-visible">
            {[0, 0.25, 0.5, 0.75, 1].map((t) => (
              <g key={t}>
                <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} stroke="var(--chart-grid)" />
                <text x={pad.l - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-[var(--ink-muted)] text-[11px]">
                  {t * 100}%
                </text>
              </g>
            ))}
            {d.trend.map((p, i) =>
              (i % step === 0 && n - 1 - i >= step / 2) || i === n - 1 ? (
                <text key={p.bucket} x={x(i)} y={H - 6} textAnchor="middle" className="fill-[var(--ink-muted)] text-[11px]">
                  {shortDay(p.bucket)}
                </text>
              ) : null,
            )}
            {[...markersAt].map(([i, ms]) => (
              <g key={i}>
                <line x1={x(i)} x2={x(i)} y1={pad.t - 8} y2={H - pad.b} stroke="var(--ink-2)" strokeDasharray="3 3" />
                <rect x={x(i) - 9} y={pad.t - 20} width={18} height={14} rx={7} fill="var(--surface-sunken)" />
                <text x={x(i)} y={pad.t - 13} dy="0.32em" textAnchor="middle" className="fill-[var(--ink)] text-[10px] font-medium">
                  {ms.length}
                </text>
              </g>
            ))}
            {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} stroke="var(--chart-axis)" />}
            {[...paths].reverse().map((s) => (
              <g key={s.key}>
                <path d={s.path} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                {/* lone points (a single day, or between breaks) still show */}
                {d.trend.map((p, i) =>
                  p[s.key].value !== null &&
                  (hover === i ||
                    sparse ||
                    ((i === 0 || d.trend[i - 1]![s.key].value === null) && (i === n - 1 || d.trend[i + 1]![s.key].value === null))) ? (
                    <circle key={i} cx={x(i)} cy={y(p[s.key].value!)} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} />
                  ) : null,
                )}
              </g>
            ))}
            {labels.map((l) => (
              <g key={l.key}>
                <rect x={l.x} y={l.ly - 1} width={8} height={2} rx={1} fill={l.color} />
                <text x={l.x + 12} y={l.ly} dy="0.32em" className="fill-[var(--ink)] text-[12px] font-medium tabular">
                  {Math.round(l.v * 100)}%
                </text>
              </g>
            ))}
          </svg>
        ) : (
          <div style={{ height: H }} />
        )}
        {/* Hit areas: one link per point, to that day's audited calls; hover and focus show the tooltip. */}
        {anyData && width > 0 && (
          <div className="absolute inset-0">
            {d.trend.map((p, i) => {
              const half = n <= 1 ? w / 2 : w / (n - 1) / 2;
              const ms = markersAt.get(i) ?? [];
              // a week point opens its 7 days, clipped to the range
              const weekEnd = new Date(Date.parse(`${p.bucket}T00:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10);
              const days = { from: p.bucket < d.filters.from ? d.filters.from : p.bucket, to: d.bucket === "week" ? (weekEnd > d.filters.to ? d.filters.to : weekEnd) : p.bucket };
              return (
                <Tip
                  key={p.bucket}
                  className="absolute top-0 h-full"
                  side="top"
                  tip={
                    <TipCard
                      title={`${d.bucket === "week" ? "Week of " : ""}${shortDay(p.bucket)} · ${fmtCount(p.audited)} audited`}
                      rows={[
                        ...TREND.map((s): [string, ReactNode] => [s.label, rateTip(p[s.key])]),
                        ...ms.map((m): [string, ReactNode] => ["Release", m.label]),
                      ]}
                    />
                  }
                >
                  <a
                    href={callsHref(d.filters, { audit: "audited" }, days)}
                    aria-label={`${shortDay(p.bucket)}: pass ${fmtPct(p.pass_rate)}, system goal ${fmtPct(p.system_goal_rate)}, business goal ${fmtPct(p.business_goal_rate)}. Open the calls.`}
                    onMouseEnter={() => setHover(i)}
                    onFocus={() => setHover(i)}
                    className="block h-full focus-visible:outline-2 focus-visible:outline-focus"
                    style={{ position: "absolute", left: x(i) - half, width: Math.max(8, half * 2) }}
                  />
                </Tip>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
});

const rateTip = (r: Rate) => (r.value === null ? "—" : `${fmtPct(r)} · ${fmtCount(r.num)}/${fmtCount(r.den)}`);

// ---------------------------------------------------------------- Histogram

/** Score distribution, bins 0–20 … 80–100; bins wholly under the pass threshold are in the attention hue. */
export const ScoreHistogram = memo(function ScoreHistogram({ d }: { d: Dashboard }) {
  const { bins, threshold, scored } = d.histogram;
  const max = Math.max(1, ...bins.map((b) => Math.max(b.calls, b.previous ?? 0)));
  if (scored === 0) return <EmptyState title="No scores yet">Scores appear once calls in this range are audited.</EmptyState>;
  return (
    <div>
      <ul className="flex h-48 items-end gap-2" aria-label="Score distribution">
        {bins.map((b, i) => {
          const lo = i * 20;
          const hi = lo + 20;
          const failing = threshold !== null && hi <= threshold;
          const extra: Record<string, string> = { min_score: String(lo), ...(i < 4 ? { max_score: String(hi) } : {}) };
          // Heights share one scale (85% of the plot leaves room for the count above the tallest bar).
          const cur = (b.calls / max) * 85;
          const prev = b.previous !== null ? (b.previous / max) * 85 : null;
          return (
            <li key={b.label} className="h-full flex-1">
              <Tip
                className="h-full w-full"
                tip={
                  <TipCard
                    title={`Score ${b.label.replace("-", "–")}`}
                    rows={[
                      ["Calls", `${fmtCount(b.calls)} of ${fmtCount(scored)}`],
                      ...(b.previous !== null ? [["Period before", fmtCount(b.previous)] as [string, ReactNode]] : []),
                      ...(failing ? [["", `Below the pass threshold (${threshold})`] as [string, ReactNode]] : []),
                    ]}
                  />
                }
              >
                <a
                  href={callsHref(d.filters, extra)}
                  aria-label={`Score ${b.label}: ${b.calls} of ${scored} scored calls${b.previous !== null ? `, ${b.previous} in the period before` : ""}${failing ? ", below the pass threshold" : ""}. Open them.`}
                  className="group relative block h-full w-full rounded-t-md focus-visible:outline-2 focus-visible:outline-focus"
                >
                  {prev !== null && prev > 0 && (
                    <span aria-hidden className="absolute inset-x-1 bottom-0 rounded-t border border-dashed border-control" style={{ height: `${prev}%` }} />
                  )}
                  <span
                    aria-hidden
                    className={`absolute inset-x-0 bottom-0 rounded-t ${failing ? "bg-serious" : "bg-series-1"} opacity-90 group-hover:opacity-100`}
                    style={{ height: `${cur}%`, minHeight: b.calls ? 3 : 0 }}
                  />
                  {/* the count sits on the current bar, whatever the period before was */}
                  <span aria-hidden className="absolute inset-x-0 text-center text-xs font-medium text-ink tabular" style={{ bottom: `calc(${cur}% + 4px)` }}>
                    {fmtCount(b.calls)}
                  </span>
                </a>
              </Tip>
            </li>
          );
        })}
      </ul>
      <div className="mt-2 flex gap-2 border-t border-chart-axis pt-2">
        {bins.map((b) => (
          <span key={b.label} className="flex-1 text-center text-[11px] text-muted tabular">
            {b.label.replace("-", "–")}
          </span>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted">
        {threshold !== null ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-sm bg-serious" aria-hidden /> Below pass threshold ({threshold})
          </span>
        ) : (
          "Pass thresholds differ across the scorecard versions in range"
        )}
        {bins[0]!.previous !== null && (
          <span className="ml-3 inline-flex items-center gap-1.5">
            <span className="size-2 rounded-sm border border-dashed border-control" aria-hidden /> Period before
          </span>
        )}
      </p>
    </div>
  );
});

// ---------------------------------------------------------------- Top failure causes

const KIND_LABEL = { condition: "Condition", check: "System check", metric: "Metric under full marks" } as const;

/** Failure conditions, failed system checks and metrics under full marks, ranked by calls affected. */
export const FailureList = memo(function FailureList({ d }: { d: Dashboard }) {
  const [all, setAll] = useState(false);
  const rows = all ? d.failures : d.failures.slice(0, 6);
  const max = Math.max(1, ...d.failures.map((f) => f.calls));
  if (d.failures.length === 0) return <EmptyState title="No failures in this range">No audited call failed a condition, a system check or a metric.</EmptyState>;
  return (
    <div>
      <ul className="flex flex-col">
        {rows.map((f, i) => {
          const extra: Record<string, string> = f.kind === "condition" ? { failure_code: f.key } : f.kind === "check" ? { check: f.key } : { metric_lost: f.key };
          return (
            <li key={`${f.kind}:${f.key}`}>
              <Tip
                className="w-full"
                tip={<TipCard title={f.label} rows={[["Calls", `${fmtCount(f.calls)} of ${fmtCount(f.of)} ${f.kind === "check" ? "where it applied" : "audited"}`], ["Kind", KIND_LABEL[f.kind]]]} />}
              >
                <a
                  href={callsHref(d.filters, extra)}
                  className="block w-full rounded-lg px-2 pt-2.5 pb-2 hover:bg-selected focus-visible:outline-2 focus-visible:outline-focus"
                >
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate text-sm text-ink">
                      {f.label}
                      <span className="ml-2 text-xs text-muted">{KIND_LABEL[f.kind]}</span>
                    </span>
                    <span className="text-sm font-medium text-ink tabular">{fmtCount(f.calls)}</span>
                  </span>
                  <span className="mt-1.5 block h-[3px] w-full rounded-full bg-sunken" aria-hidden>
                    <span className={`block h-full rounded-full ${f.calls === max ? "bg-series-1" : "bg-chart-muted"}`} style={{ width: `${(f.calls / max) * 100}%` }} />
                  </span>
                </a>
              </Tip>
            </li>
          );
        })}
      </ul>
      {d.failures.length > 6 && (
        <button type="button" className="mt-2 px-2 text-sm text-ink-2 hover:text-ink" onClick={() => setAll((a) => !a)} aria-expanded={all}>
          {all ? "Show top 6" : `Show all ${d.failures.length}`}
        </button>
      )}
    </div>
  );
});

// ---------------------------------------------------------------- Outcome buckets

const TONE_DOT = { good: "bg-good", warning: "bg-warning", critical: "bg-critical", serious: "bg-serious", neutral: "bg-faint" } as const;

/** The system × business outcome buckets (PRD §3), each with its share of calls where both goals applied. */
export const OutcomeBuckets = memo(function OutcomeBuckets({ d }: { d: Dashboard }) {
  const cur = d.buckets.current;
  const applicable = BUCKETS.reduce((s, b) => s + cur[b.key], 0);
  return (
    <div>
      <div className="grid grid-cols-2 gap-3">
        {BUCKETS.map((b) => {
          const prev = d.buckets.previous?.[b.key] ?? null;
          return (
            <Tip
              key={b.key}
              className="w-full"
              tip={<TipCard title={b.label} rows={[["", b.tip], ["Calls", `${fmtCount(cur[b.key])} of ${fmtCount(applicable)} with both goals applicable`], ...(prev !== null ? [["Period before", fmtCount(prev)] as [string, ReactNode]] : [])]} />}
            >
              <a
                href={callsHref(d.filters, { bucket: b.key })}
                className="block w-full rounded-xl border border-line px-4 py-3 hover:bg-selected focus-visible:outline-2 focus-visible:outline-focus"
              >
                <span className="flex items-center gap-1.5 text-[13px] text-ink-2">
                  <span className={`size-2 rounded-full ${TONE_DOT[b.tone]}`} aria-hidden />
                  {b.label}
                </span>
                <span className="mt-1 flex items-baseline gap-2">
                  <span className="text-2xl font-medium text-ink tabular">{fmtCount(cur[b.key])}</span>
                  <span className="text-xs text-muted tabular">{applicable ? `${Math.round((cur[b.key] / applicable) * 100)}%` : "—"}</span>
                </span>
              </a>
            </Tip>
          );
        })}
      </div>
      {cur.na > 0 && (
        <a href={callsHref(d.filters, { bucket: "na" })} className="mt-3 inline-block text-xs text-muted hover:text-ink">
          {fmtCount(cur.na)} more where a goal didn't apply
        </a>
      )}
    </div>
  );
});

// ---------------------------------------------------------------- Heatmap

/** Agents × metrics, average % of the metric's maximum. Warm cells need attention; under 5 calls the cell is greyed. */
export const MetricHeatmap = memo(function MetricHeatmap({ d }: { d: Dashboard }) {
  const { agents, metrics, cells } = d.heatmap;
  if (!metrics.length) return <EmptyState title="No metric scores yet">Metric averages appear once calls in this range are audited.</EmptyState>;
  const tone = (v: number | null, n: number) =>
    v === null ? "bg-sunken text-muted" : n < 5 ? "border border-dashed border-control text-muted" : v >= 80 ? "bg-good-soft text-ink" : v >= 70 ? "bg-sunken text-ink" : "bg-serious-soft text-ink";
  return (
    <div className="overflow-x-auto xl:overflow-visible">
      <table className="w-full border-separate border-spacing-1 text-sm">
        <thead>
          <tr>
            <th scope="col" className="sticky left-0 bg-surface px-2 text-left text-xs font-normal text-muted">
              Agent
            </th>
            {metrics.map((m) => (
              <th key={m.key} scope="col" className="min-w-16 px-1 text-center text-xs font-normal text-muted">
                <span className="line-clamp-2">{m.label}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {agents.map((a, ai) => (
            <tr key={a.code}>
              <th scope="row" className="sticky left-0 bg-surface px-2 text-left font-medium whitespace-nowrap text-ink">
                {a.label}
              </th>
              {metrics.map((m, mi) => {
                const c = cells[ai]![mi]!;
                return (
                  <td key={m.key} className="p-0">
                    <Tip className="w-full" tip={<TipCard title={`${a.label} · ${m.label}`} rows={[["Average", c.value === null ? "—" : `${c.value}%`], ["Calls", fmtCount(c.n)], ...(c.n > 0 && c.n < 5 ? [["", "Fewer than 5 calls"] as [string, ReactNode]] : [])]} />}>
                      <a
                        href={callsHref({ ...d.filters, agent: a.code }, { metric_lost: m.key })}
                        aria-label={`${a.label}, ${m.label}: ${c.value === null ? "no score" : `${c.value}%`} over ${c.n} calls`}
                        className={`flex h-10 w-full items-center justify-center rounded-lg text-sm tabular focus-visible:outline-2 focus-visible:outline-focus ${tone(c.value, c.n)}`}
                      >
                        {c.value === null ? "—" : Math.round(c.value)}
                      </a>
                    </Tip>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm border border-line bg-good-soft" aria-hidden />
          80% and above
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm border border-line bg-sunken" aria-hidden />
          70–79%
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm border border-dashed border-control" aria-hidden />
          Fewer than 5 calls
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm border border-line bg-serious-soft" aria-hidden />
          Under 70%
        </span>
      </p>
    </div>
  );
});

// ---------------------------------------------------------------- Funnel

/** Connected → audited → conversation completed → goal discussed → achieved, per agent, with not-achieved reasons. */
export const GoalFunnel = memo(function GoalFunnel({ d }: { d: Dashboard }) {
  const [pick, setPick] = useState<string>("all");
  const f = d.funnel.find((x) => (x.agent ?? "all") === pick) ?? d.funnel[0]!;
  const top = Math.max(1, ...f.stages.map((s) => s.calls));
  const links: Record<string, Record<string, string>> = {
    connected: { status: "completed" },
    audited: { audit: "audited" },
    conversation_completed: { audit: "audited", check_ok: "S2" },
    goal_discussed: { business_goal: "APPLICABLE" },
    achieved: { business_goal: "ACHIEVED" },
  };
  const filters = f.agent ? { ...d.filters, agent: f.agent } : d.filters;
  return (
    <div>
      {d.funnel.length > 1 && (
        <label className="mb-3 inline-flex items-center gap-2 text-xs text-muted">
          Agent
          <select
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            className="h-8 rounded-full border border-control bg-surface px-3 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            {d.funnel.map((x) => (
              <option key={x.agent ?? "all"} value={x.agent ?? "all"}>
                {x.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {f.stages[0]!.calls === 0 && f.stages[1]!.calls === 0 ? (
        <EmptyState title="No connected calls in this range" />
      ) : (
        <ol className="flex flex-col gap-2" aria-describedby="funnel-pct-note">
          {f.stages.map((s, i) => {
            const prev = i > 0 ? f.stages[i - 1]!.calls : null;
            return (
              <li key={s.key}>
                <Tip
                  className="w-full"
                  tip={
                    <TipCard
                      title={FUNNEL_LABELS[s.key]!}
                      rows={[
                        ["", FUNNEL_TIPS[s.key]!],
                        ["Calls", fmtCount(s.calls)],
                        ...(prev ? [["Of the stage before", `${Math.round((s.calls / prev) * 100)}%`] as [string, ReactNode]] : []),
                        ...(s.key === "achieved" ? [["Partial (not counted)", fmtCount(f.partial)] as [string, ReactNode]] : []),
                      ]}
                    />
                  }
                >
                  <a href={callsHref(filters, links[s.key]!)} className="grid w-full grid-cols-[minmax(0,7.5rem)_1fr_auto] sm:grid-cols-[minmax(0,12rem)_1fr_auto] items-center gap-3 rounded-lg px-1 py-1 hover:bg-selected focus-visible:outline-2 focus-visible:outline-focus">
                    <span className="truncate text-sm text-ink-2">{FUNNEL_LABELS[s.key]}</span>
                    <span className="h-6 rounded-md bg-sunken">
                      <span className="block h-full rounded-md bg-series-3" style={{ width: `${(s.calls / top) * 100}%`, opacity: 1 - i * 0.12 }} />
                    </span>
                    <span className="w-20 text-right text-sm text-ink tabular sm:w-24">
                      {fmtCount(s.calls)}
                      {prev ? <span className="ml-1.5 text-xs text-muted">{Math.round((s.calls / prev) * 100)}%</span> : null}
                    </span>
                  </a>
                </Tip>
              </li>
            );
          })}
        </ol>
      )}
      <p id="funnel-pct-note" className="mt-2 text-xs text-muted">
        % is of the stage before{f.partial > 0 ? ` · Partial: ${fmtCount(f.partial)} calls, not counted as achieved` : ""}
      </p>
      {f.reasons.length > 0 && (
        <div className="mt-4">
          <h3 className="mb-1.5 text-xs text-muted">Not achieved, by reason</h3>
          <ul className="flex flex-wrap gap-2">
            {f.reasons.map((r) => (
              <li key={r.reason}>
                <a
                  href={callsHref(filters, { business_reason: r.reason })}
                  className="inline-flex items-center gap-1.5 rounded-full bg-sunken px-3 py-1 text-xs text-ink hover:bg-line-strong focus-visible:outline-2 focus-visible:outline-focus"
                >
                  {humanize(r.reason)} <span className="text-muted tabular">{fmtCount(r.calls)}</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
});

// ---------------------------------------------------------------- Agent table

function Sparkline({ values }: { values: (number | null)[] }) {
  const W = 72;
  const H = 22;
  const n = values.length;
  let path = "";
  let pen = false;
  values.forEach((v, i) => {
    if (v === null) return void (pen = false);
    path += `${pen ? "L" : "M"}${r1(n <= 1 ? W / 2 : (i * W) / (n - 1))},${r1(2 + (1 - v) * (H - 4))}`;
    pen = true;
  });
  if (!path) return <span className="text-muted">—</span>;
  const points = values.flatMap((v, i) => (v === null ? [] : [{ i, v }]));
  return (
    <svg width={W} height={H} aria-hidden className="overflow-visible">
      <path d={path} fill="none" stroke="var(--chart-muted)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      {points.length === 1 && (
        <circle cx={r1(n <= 1 ? W / 2 : (points[0]!.i * W) / (n - 1))} cy={r1(2 + (1 - points[0]!.v) * (H - 4))} r={2.5} fill="var(--chart-muted)" />
      )}
    </svg>
  );
}

function RateCell({ r, tip }: { r: Rate; tip: string }) {
  return (
    <Tip tip={r.value === null ? "No calls behind this" : tip} side="bottom">
      <span tabIndex={0} className="rounded tabular focus-visible:outline-2 focus-visible:outline-focus">
        {fmtPct(r)}
      </span>
    </Tip>
  );
}

/** Per agent: calls, rates with their denominators, average score and the daily pass-rate trend. */
export const AgentTable = memo(function AgentTable({ d, onAgent }: { d: Dashboard; onAgent: (code: string) => void }) {
  if (!d.agents.length) return <EmptyState title="No calls in this range" />;
  return (
    <div className="overflow-x-auto lg:overflow-visible">
      <table className="w-full min-w-[760px] text-sm">
        <thead>
          <tr className="text-xs text-muted">
            <th scope="col" className="py-2 pr-3 text-left font-normal">Agent</th>
            <th scope="col" className="px-3 text-right font-normal">Calls</th>
            <th scope="col" className="px-3 text-right font-normal">Connected</th>
            <th scope="col" className="px-3 text-right font-normal">Audited</th>
            <th scope="col" className="px-3 text-right font-normal">Pass rate</th>
            <th scope="col" className="px-3 text-right font-normal">System goal</th>
            <th scope="col" className="px-3 text-right font-normal">Business goal</th>
            <th scope="col" className="px-3 text-right font-normal">Avg score</th>
            <th scope="col" className="pl-3 text-left font-normal">Pass rate trend</th>
          </tr>
        </thead>
        <tbody>
          {d.agents.map((a) => (
            <tr key={a.code} className="border-t border-line">
              <th scope="row" className="py-2.5 pr-3 text-left font-medium">
                <button type="button" className="rounded text-ink hover:underline focus-visible:outline-2 focus-visible:outline-focus" onClick={() => onAgent(a.code)}>
                  {a.label}
                </button>
              </th>
              <td className="px-3 text-right tabular">{fmtCount(a.total_calls)}</td>
              <td className="px-3 text-right tabular">{fmtCount(a.connected)}</td>
              <td className="px-3 text-right tabular">
                <a href={callsHref({ ...d.filters, agent: a.code }, { audit: "audited" })} className="hover:underline">
                  {fmtCount(a.audited)}
                </a>
              </td>
              <td className="px-3 text-right">
                <RateCell r={a.pass_rate} tip={`${fmtCount(a.pass_rate.num)} of ${fmtCount(a.pass_rate.den)} audited calls passed${a.previous_pass_rate?.value != null ? ` · was ${fmtPct(a.previous_pass_rate)}` : ""}`} />
              </td>
              <td className="px-3 text-right">
                <RateCell r={a.system_goal_rate} tip={`${fmtCount(a.system_goal_rate.num)} of ${fmtCount(a.system_goal_rate.den)} applicable calls`} />
              </td>
              <td className="px-3 text-right">
                <RateCell r={a.business_goal_rate} tip={`${fmtCount(a.business_goal_rate.num)} of ${fmtCount(a.business_goal_rate.den)} applicable calls · Partial ${fmtPct(a.partial_share)}`} />
              </td>
              <td className="px-3 text-right tabular">{fmtScore(a.average_score)}</td>
              <td className="pl-3">
                <Sparkline values={a.spark} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});

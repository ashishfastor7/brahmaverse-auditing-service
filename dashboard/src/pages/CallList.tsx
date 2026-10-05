import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { CircleDashed, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { api, callsApi, type CallFilters, type CallRow } from "../api";
import { Badge, Card, formatDate, formatDuration, GoalBadge, humanize, ReviewBadge, ScorePill, Select, StatTile, SuccessBadge } from "../components/ui";

const PAGE_SIZE = 25;

export const STATUS_LABEL: Record<string, string> = {
  completed: "Completed",
  no_answer: "No answer",
  failed: "Failed",
  dialing: "Dialing",
  ongoing: "Ongoing",
  queued: "Queued",
  skipped: "Skipped",
};

function setFilters(next: CallFilters) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(next)) if (v) p.set(k, v);
  window.location.hash = `/?${p.toString()}`;
}

function AuditCell({ row }: { row: CallRow }) {
  const a = row.audit;
  if (!a) {
    const auditable = row.status === "completed" && row.turns > 0;
    return <span className="text-xs text-muted">{auditable ? "Not audited" : "—"}</span>;
  }
  if (a.status === "skipped") return <span className="text-xs text-muted">Skipped · {humanize(a.skip_reason ?? "")}</span>;
  if (a.status === "failed") return <span className="text-xs text-ink-2">Audit failed</span>;
  if (a.status === "pending") return <Badge tone="neutral" icon={CircleDashed}>Auditing…</Badge>;
  return <ScorePill score={a.overall_score} />;
}

export function CallList({ search }: { search: string }) {
  const filters: CallFilters = Object.fromEntries(new URLSearchParams(search));
  const page = Number(filters.page ?? 1);
  const update = (patch: CallFilters) => setFilters({ ...filters, ...patch, page: patch.page ?? "" });

  // The search box applies on Enter or after a pause, not on every keystroke.
  const [searchText, setSearchText] = useState(filters.search ?? "");
  useEffect(() => setSearchText(filters.search ?? ""), [filters.search]);
  useEffect(() => {
    if (searchText === (filters.search ?? "")) return;
    const t = setTimeout(() => update({ search: searchText.trim() }), 500);
    return () => clearTimeout(t);
  }, [searchText]);

  const agents = useQuery({ queryKey: ["agents"], queryFn: api.agents, staleTime: Infinity });
  const list = useQuery({ queryKey: ["calls", filters], queryFn: () => callsApi.list(filters), placeholderData: keepPreviousData });
  const stats = useQuery({ queryKey: ["call-stats", filters.agent_code], queryFn: () => callsApi.stats(filters.agent_code) });

  const agentOptions: [string, string][] = [["", "All agents"], ...(agents.data?.agents ?? []).map((a): [string, string] => [a.code, a.label])];
  const s = stats.data;
  const totalPages = list.data ? Math.max(1, Math.ceil(list.data.total / PAGE_SIZE)) : 1;
  const statusOptions: [string, string][] = [
    ["", "Any status"],
    ...Object.entries(STATUS_LABEL).map(([v, l]): [string, string] => [
      v,
      `${l}${s?.calls_by_status[v] !== undefined ? ` (${s.calls_by_status[v].toLocaleString()})` : ""}`,
    ]),
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatTile
          label="Calls in database"
          value={s ? s.total_calls.toLocaleString() : "—"}
          hint={
            s ? `${(s.calls_by_status.completed ?? 0).toLocaleString()} completed · ${(s.calls_by_status.no_answer ?? 0).toLocaleString()} no answer` : undefined
          }
        />
        <StatTile label="Audited" value={s ? s.audited.toLocaleString() : "—"} hint={s?.avg_score != null ? `average score ${s.avg_score}` : "no audits yet"} />
        <StatTile label="Success rate" value={s?.success_rate != null ? `${s.success_rate}%` : "—"} hint="audited calls with no failures" />
        <StatTile label="Goal rate" value={s?.goal_rate != null ? `${s.goal_rate}%` : "—"} hint="excludes not-applicable calls" />
        <StatTile label="Needs review" value={s ? s.needs_review.toLocaleString() : "—"} hint="low auditor confidence" />
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted">
          Search
          <span className="relative">
            <Search size={14} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
            <input
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && update({ search: searchText.trim() })}
              placeholder="Call id, name or summary"
              className="h-8 w-56 rounded-md border border-line bg-surface pl-7 pr-2 text-sm text-ink focus:outline-2 focus:outline-accent"
            />
          </span>
        </label>
        <Select label="Agent" value={filters.agent_code ?? ""} onChange={(v) => update({ agent_code: v })} options={agentOptions} />
        <Select label="Call status" value={filters.status ?? ""} onChange={(v) => update({ status: v })} options={statusOptions} />
        <Select
          label="Direction"
          value={filters.call_type ?? ""}
          onChange={(v) => update({ call_type: v })}
          options={[["", "Any"], ["outbound", "Outbound"], ["inbound", "Inbound"]]}
        />
        <Select
          label="Audit"
          value={filters.audit ?? ""}
          onChange={(v) => update({ audit: v })}
          options={[["", "All calls"], ["audited", "Audited"], ["not_audited", "Not audited"]]}
        />
        <Select
          label="Pass / fail"
          value={filters.success ?? ""}
          onChange={(v) => update({ success: v })}
          options={[["", "Any"], ["PASS", "Pass"], ["FAIL", "Fail"]]}
        />
        <Select
          label="Goal"
          value={filters.goal ?? ""}
          onChange={(v) => update({ goal: v })}
          options={[["", "Any"], ["ACHIEVED", "Achieved"], ["NOT_ACHIEVED", "Not achieved"], ["NOT_APPLICABLE", "Not applicable"]]}
        />
        <Select
          label="Sort"
          value={filters.sort ?? "newest"}
          onChange={(v) => update({ sort: v === "newest" ? "" : v })}
          options={[["newest", "Newest first"], ["oldest", "Oldest first"], ["score_asc", "Lowest score"], ["score_desc", "Highest score"]]}
        />
        {Object.keys(filters).some((k) => k !== "page") && (
          <button onClick={() => setFilters({})} className="h-8 text-sm text-accent hover:underline">
            Clear filters
          </button>
        )}
      </div>

      {s && s.top_failures.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted">Most common failures:</span>
          {s.top_failures.map((f) => (
            <button
              key={f.code}
              onClick={() => update({ failure_code: filters.failure_code === f.code ? "" : f.code })}
              aria-pressed={filters.failure_code === f.code}
              className={`rounded-md border px-2 py-0.5 text-ink hover:bg-sunken ${
                filters.failure_code === f.code ? "border-accent bg-sunken" : "border-line bg-surface"
              }`}
            >
              {humanize(f.code)} <span className="tabular text-muted">{f.count}</span>
            </button>
          ))}
        </div>
      )}

      <Card className="overflow-hidden" title={`Calls${list.data ? ` · ${list.data.total.toLocaleString()}` : ""}`}>
        {list.isError ? (
          <p className="text-sm text-ink">Could not load calls: {(list.error as Error).message}</p>
        ) : list.data && list.data.data.length === 0 ? (
          <p className="text-sm text-muted">No calls match these filters.</p>
        ) : (
          <div className="-m-4 overflow-x-auto">
            <table className="w-full min-w-250 text-sm">
              <thead className="bg-sunken text-left text-xs text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Call</th>
                  <th className="px-3 py-2 font-medium">When</th>
                  <th className="px-3 py-2 font-medium">Agent</th>
                  <th className="px-3 py-2 font-medium">Contact</th>
                  <th className="px-3 py-2 font-medium">Direction</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Duration</th>
                  <th className="px-3 py-2 font-medium">Score</th>
                  <th className="px-3 py-2 font-medium">Pass / fail</th>
                  <th className="px-3 py-2 font-medium">Goal</th>
                  <th className="px-3 py-2 font-medium">Notes</th>
                </tr>
              </thead>
              <tbody>
                {(list.data?.data ?? []).map((row) => (
                  <tr key={row.id} onClick={() => (window.location.hash = `/calls/${row.id}`)} className="cursor-pointer border-t border-line hover:bg-sunken">
                    <td className="px-4 py-2.5 font-medium tabular">#{row.id}</td>
                    <td className="px-3 py-2.5 text-ink-2 whitespace-nowrap">{formatDate(row.created_at)}</td>
                    <td className="px-3 py-2.5 text-ink-2 whitespace-nowrap">{row.agent_label ?? (row.agent_id ? `Agent ${row.agent_id}` : "—")}</td>
                    <td className="max-w-40 truncate px-3 py-2.5 text-ink-2">{row.contact_name ?? "—"}</td>
                    <td className="px-3 py-2.5 text-ink-2">{row.call_type ? humanize(row.call_type) : "—"}</td>
                    <td className="px-3 py-2.5 text-ink-2 whitespace-nowrap">{STATUS_LABEL[row.status] ?? humanize(row.status)}</td>
                    <td className="px-3 py-2.5 text-ink-2 tabular">{formatDuration(row.duration)}</td>
                    <td className="px-3 py-2.5">
                      <AuditCell row={row} />
                    </td>
                    <td className="px-3 py-2.5">{row.audit?.status === "completed" && <SuccessBadge result={row.audit.success_result} />}</td>
                    <td className="px-3 py-2.5">{row.audit?.status === "completed" && <GoalBadge result={row.audit.goal_result} />}</td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {row.audit?.needs_review && <ReviewBadge />}
                        {(row.audit?.failure_codes ?? []).slice(0, 2).map((c) => (
                          <span key={c} className="text-xs text-ink-2">
                            {humanize(c)}
                          </span>
                        ))}
                        {!row.audit && row.ended_reason && row.status !== "completed" && <span className="text-xs text-muted">{humanize(row.ended_reason)}</span>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {totalPages > 1 && (
        <div className="flex items-center justify-end gap-3 text-sm">
          <button disabled={page <= 1} onClick={() => update({ page: String(page - 1) })} className="text-accent disabled:text-muted">
            ← Previous
          </button>
          <span className="text-muted tabular">
            Page {page} of {totalPages.toLocaleString()}
          </span>
          <button disabled={page >= totalPages} onClick={() => update({ page: String(page + 1) })} className="text-accent disabled:text-muted">
            Next →
          </button>
        </div>
      )}
    </div>
  );
}

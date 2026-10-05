import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api, type Filters } from "../api";
import {
  Card,
  formatDate,
  formatDuration,
  GoalBadge,
  humanize,
  ReviewBadge,
  ScorePill,
  Select,
  StatTile,
  StatusBadge,
  SuccessBadge,
} from "../components/ui";

const PAGE_SIZE = 25;

function setFilters(next: Filters) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(next)) if (v) p.set(k, v);
  window.location.hash = `/?${p.toString()}`;
}

export function CallList({ search }: { search: string }) {
  const filters: Filters = Object.fromEntries(new URLSearchParams(search));
  const page = Number(filters.page ?? 1);
  const update = (patch: Filters) => setFilters({ ...filters, ...patch, page: patch.page ?? "" });

  const rubrics = useQuery({ queryKey: ["rubrics"], queryFn: api.rubrics, staleTime: Infinity });
  const list = useQuery({ queryKey: ["audits", filters], queryFn: () => api.list(filters), placeholderData: keepPreviousData });
  const stats = useQuery({ queryKey: ["stats", filters.agent_code], queryFn: () => api.stats({ agent_code: filters.agent_code }) });

  const agentOptions: [string, string][] = [
    ["", "All agents"],
    ...(rubrics.data ?? []).flatMap((r) => r.agent_codes.slice(0, 1).map((c): [string, string] => [c, r.agent_label])),
  ];
  const s = stats.data;
  const totalPages = list.data ? Math.max(1, Math.ceil(list.data.total / PAGE_SIZE)) : 1;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <Select label="Agent" value={filters.agent_code ?? ""} onChange={(v) => update({ agent_code: v })} options={agentOptions} />
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
          label="Audit status"
          value={filters.status ?? ""}
          onChange={(v) => update({ status: v })}
          options={[["", "Any"], ["completed", "Audited"], ["skipped", "Skipped"], ["failed", "Audit failed"], ["pending", "In progress"]]}
        />
        <Select
          label="Review"
          value={filters.needs_review ?? ""}
          onChange={(v) => update({ needs_review: v })}
          options={[["", "Any"], ["true", "Needs review"]]}
        />
        <Select
          label="Sort"
          value={filters.sort ?? "newest"}
          onChange={(v) => update({ sort: v === "newest" ? "" : v })}
          options={[["newest", "Newest first"], ["oldest", "Oldest first"], ["score_asc", "Lowest score"], ["score_desc", "Highest score"]]}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatTile label="Calls audited" value={s ? s.audited.toLocaleString() : "—"} hint={s ? `${s.skipped} skipped · ${s.failed_audits} failed` : undefined} />
        <StatTile label="Average score" value={s?.avg_score ?? "—"} hint="out of 100" />
        <StatTile label="Success rate" value={s?.success_rate != null ? `${s.success_rate}%` : "—"} hint="calls with no failures" />
        <StatTile label="Goal rate" value={s?.goal_rate != null ? `${s.goal_rate}%` : "—"} hint="excludes not-applicable calls" />
        <StatTile label="Needs review" value={s ? s.needs_review.toLocaleString() : "—"} hint="low auditor confidence" />
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
          <p className="text-sm text-ink">Could not load audits: {(list.error as Error).message}</p>
        ) : list.data && list.data.data.length === 0 ? (
          <p className="text-sm text-muted">No calls match these filters yet. Audits appear here as calls end, or after running a replay.</p>
        ) : (
          <div className="-m-4 overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="bg-sunken text-left text-xs text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Call</th>
                  <th className="px-3 py-2 font-medium">When</th>
                  <th className="px-3 py-2 font-medium">Agent</th>
                  <th className="px-3 py-2 font-medium">Duration</th>
                  <th className="px-3 py-2 font-medium">Score</th>
                  <th className="px-3 py-2 font-medium">Pass / fail</th>
                  <th className="px-3 py-2 font-medium">Goal</th>
                  <th className="px-3 py-2 font-medium">Notes</th>
                </tr>
              </thead>
              <tbody>
                {(list.data?.data ?? []).map((row) => (
                  <tr
                    key={row.id}
                    onClick={() => (window.location.hash = `/audits/${row.id}`)}
                    className="cursor-pointer border-t border-line hover:bg-sunken"
                  >
                    <td className="px-4 py-2.5 font-medium tabular">#{row.call_id}</td>
                    <td className="px-3 py-2.5 text-ink-2 whitespace-nowrap">{formatDate(row.call_created_at)}</td>
                    <td className="px-3 py-2.5 text-ink-2">{row.agent_code ?? "—"}</td>
                    <td className="px-3 py-2.5 text-ink-2 tabular">{formatDuration(row.duration)}</td>
                    <td className="px-3 py-2.5">{row.status === "completed" ? <ScorePill score={row.overall_score} /> : <StatusBadge status={row.status} reason={row.skip_reason} />}</td>
                    <td className="px-3 py-2.5">
                      <SuccessBadge result={row.success_result} />
                    </td>
                    <td className="px-3 py-2.5">
                      <GoalBadge result={row.goal_result} />
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {row.needs_review && <ReviewBadge />}
                        {row.failure_codes.slice(0, 2).map((c) => (
                          <span key={c} className="text-xs text-ink-2">
                            {humanize(c)}
                          </span>
                        ))}
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
            Page {page} of {totalPages}
          </span>
          <button disabled={page >= totalPages} onClick={() => update({ page: String(page + 1) })} className="text-accent disabled:text-muted">
            Next →
          </button>
        </div>
      )}
    </div>
  );
}

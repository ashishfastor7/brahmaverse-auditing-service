import type { AuditHistoryEntry } from "../../api";
import { Card, formatDate, humanize } from "../ui";
import { PassBadge } from "./verdict";

/**
 * PRD §5 item 8, P2-3: every v2 audit of the call (newest first) and its re-scores, with the scorecard and goal
 * versions and the weights each used. Opening an older one shows it read-only.
 */

const weightsText = (w: Record<string, number> | null) =>
  w
    ? Object.entries(w)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => `${humanize(k)} ${v}%`)
        .join(" · ")
    : "—";

export function AuditHistory({ entries, callId, shownId }: { entries: AuditHistoryEntry[]; callId: number; shownId: number }) {
  const current = entries.find((e) => e.status === "completed" && e.superseded_by === null)?.id;
  return (
    <Card title={`Audit history · ${entries.length}`}>
      <ol className="flex flex-col divide-y divide-line">
        {entries.map((e) => (
          <li key={e.id} className="py-2.5 text-sm first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <a
                href={e.id === current ? `#/calls/${callId}` : `#/calls/${callId}/audits/${e.id}`}
                aria-current={e.id === shownId ? "page" : undefined}
                className={`font-medium hover:underline ${e.id === shownId ? "text-ink" : "text-accent"}`}
              >
                {formatDate(e.audited_at ?? e.created_at)}
                {e.id === current && <span className="ml-1.5 text-xs font-normal text-muted">current</span>}
                {e.id === shownId && e.id !== current && <span className="ml-1.5 text-xs font-normal text-muted">shown</span>}
              </a>
              <span className="flex items-center gap-2">
                {e.status === "completed" ? (
                  <>
                    <span className="font-semibold text-ink tabular">{e.score ?? "—"}</span>
                    <PassBadge passed={e.success_result === null ? null : e.success_result === "PASS"} />
                  </>
                ) : (
                  <span className="text-xs text-muted">{humanize(e.status)}</span>
                )}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-muted">
              {e.scorecard_id ? `${e.scorecard_id} v${e.scorecard_version} · goal v${e.goal_version} · ` : ""}
              {e.judge_prompt_version ?? "—"} · by {e.triggered_by ?? "—"}
            </p>
            <details className="mt-1 text-xs">
              <summary className="cursor-pointer text-muted hover:text-ink">Weights used</summary>
              <p className="mt-1 text-ink-2">{weightsText(e.weights_used)}</p>
            </details>
            {e.rescores.length > 0 && (
              <ul className="mt-1.5 flex flex-col gap-1 border-l border-line pl-3 text-xs">
                {e.rescores.map((s) => (
                  <li key={s.id} className="text-ink-2">
                    Re-scored {formatDate(s.created_at)}: <span className="font-medium text-ink tabular">{s.score ?? "—"}</span>{" "}
                    {s.passed ? "pass" : "fail"} · by {s.created_by}
                    <span className="block text-muted">{weightsText(s.weights_used)}</span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
    </Card>
  );
}

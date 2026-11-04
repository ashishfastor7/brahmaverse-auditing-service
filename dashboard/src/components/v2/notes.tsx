import { AlertTriangle, ArrowRight, CheckCircle2 } from "lucide-react";
import type { AuditResultV2, Sentiment } from "../../api";
import { Badge, Card } from "../ui";
import { TurnChips } from "./evidence";

/**
 * PRD §5 item 10, P1-22: the judge's plain-language notes for the reviewer. They never change the score, checks,
 * outcome or flags; every point links to its turns. Audits made before judge prompt v2-2 have only the summary.
 */

const SEVERITY = { high: "High", medium: "Medium", low: "Low" } as const;
const SEVERITY_TONE = { high: "critical", medium: "warning", low: "neutral" } as const;
const SENTIMENT: Record<Sentiment, string> = {
  positive: "Positive",
  neutral: "Neutral",
  negative: "Negative",
  frustrated: "Frustrated",
  confused: "Confused",
};

export function AuditorNotes({ r }: { r: AuditResultV2 }) {
  const n = r.notes;
  return (
    <Card title="Auditor notes">
      <div className="flex flex-col gap-5 text-sm">
        <section aria-labelledby="note-summary">
          <h3 id="note-summary" className="text-xs text-muted">
            Call summary
          </h3>
          <p className="mt-1 text-ink">{r.call_summary ?? "—"}</p>
        </section>

        {n ? (
          <>
            <section aria-labelledby="note-well">
              <h3 id="note-well" className="text-xs text-muted">
                What went well
              </h3>
              {n.went_well.length === 0 ? (
                <p className="mt-1 text-muted">Nothing stood out.</p>
              ) : (
                <ul className="mt-1.5 flex flex-col gap-2">
                  {n.went_well.map((w, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <CheckCircle2 size={15} className="mt-0.5 flex-none text-good" aria-hidden />
                      <span className="text-ink">
                        {w.point} <TurnChips turns={w.turns} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-labelledby="note-improve">
              <h3 id="note-improve" className="text-xs text-muted">
                What to improve
              </h3>
              {n.improvements.length === 0 ? (
                <p className="mt-1 text-muted">Nothing to fix on this call.</p>
              ) : (
                <ul className="mt-1.5 flex flex-col gap-3">
                  {n.improvements.map((w, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <AlertTriangle size={15} className="mt-0.5 flex-none text-muted" aria-hidden />
                      <div className="min-w-0">
                        <p className="text-ink">
                          {w.point}{" "}
                          <Badge tone={SEVERITY_TONE[w.severity]} icon={AlertTriangle}>
                            {SEVERITY[w.severity]}
                          </Badge>
                        </p>
                        <p className="mt-1 text-ink-2">
                          <span className="font-medium text-ink">Try instead: </span>
                          {w.suggestion}
                        </p>
                        <div className="mt-1">
                          <TurnChips turns={w.turns} />
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-labelledby="note-sentiment">
              <h3 id="note-sentiment" className="text-xs text-muted">
                Caller's mood
              </h3>
              <p className="mt-1 flex items-center gap-1.5 font-medium text-ink">
                {SENTIMENT[n.sentiment.start]}
                <ArrowRight size={14} className="text-muted" aria-hidden />
                <span className="sr-only">to</span>
                {SENTIMENT[n.sentiment.end]}
              </p>
              <p className="mt-0.5 text-ink-2">{n.sentiment.note}</p>
            </section>

            <section aria-labelledby="note-conclusion">
              <h3 id="note-conclusion" className="text-xs text-muted">
                Conclusion
              </h3>
              <p className="mt-1 text-ink">{n.conclusion}</p>
            </section>
          </>
        ) : (
          <p className="text-xs text-muted">This audit was made before auditor notes existed. Re-audit the call to add them.</p>
        )}
      </div>
    </Card>
  );
}

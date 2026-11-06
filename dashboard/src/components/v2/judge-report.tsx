import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Download, RefreshCw } from "lucide-react";
import { spotCheckApi, type JudgeReport } from "../../api";
import { formatGeneratedAt, formatRate, reportPdf } from "../../lib/report-pdf";
import { Badge, Button, Card, ErrorNote } from "../ui";

/**
 * The AI judge evaluation on the spot-check page. Generating reads the golden set as audited (`GET /v2/spot-checks/report`):
 * instant, no judge call, nothing saved. The report is kept for the session, so changing week doesn't lose it.
 *
 * Layout: one three-column grid, so the sums close. The stats take a column each; the table takes the first two, because
 * stretched across the card its figures sit too far from their names; the insights take the third, under Blind agreement.
 */

function downloadPdf(report: JudgeReport) {
  const url = URL.createObjectURL(new Blob([reportPdf(report) as BlobPart], { type: "application/pdf" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `ai-judge-evaluation-${report.generated_at.slice(0, 10)}.pdf`;
  link.click();
  URL.revokeObjectURL(url);
}

function Stat({ value, label, hint, lead = false }: { value: string; label: string; hint: string; lead?: boolean }) {
  return (
    <div className={`min-w-0 rounded-xl border border-line px-4 py-3 ${lead ? "bg-sunken" : "bg-surface"}`}>
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-ink tabular">{value}</p>
      <p className="text-xs text-muted tabular">{hint}</p>
    </div>
  );
}

/** Slim 3px agreement bar. Grey under the minimum base (a tiny base never shouts), critical when below the bar, accent otherwise. */
function RateBar({ rate, small, weak }: { rate: number | null; small: boolean; weak: boolean }) {
  const fill = small ? "bg-muted/60" : weak ? "bg-critical" : "bg-accent";
  return (
    <span className="block h-[3px] w-20 overflow-hidden rounded-full bg-accent-track" aria-hidden>
      <span className={`block h-full rounded-full ${fill}`} style={{ width: `${Math.round((rate ?? 0) * 100)}%` }} />
    </span>
  );
}

const MIN_BASE = 5;

function Report({ report }: { report: JudgeReport }) {
  if (report.calls === 0)
    return <p className="text-sm text-ink-2">No Golden Set calls yet. Agree with or dispute an audit, or finish a blind spot-check, and it will count here.</p>;
  const rows = [...report.parameters].sort((a, b) => Number(b.needs_improvement) - Number(a.needs_improvement));
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat lead value={formatRate(report.overall.rate)} label="Overall agreement" hint={`${report.overall.agree} of ${report.overall.total} decisions`} />
        <Stat value={report.calls.toLocaleString()} label="Golden Set calls" hint={`${report.blind_calls} blind spot-checks`} />
        <Stat value={formatRate(report.blind.rate)} label="Blind agreement" hint={`${report.blind.agree} of ${report.blind.total} decisions`} />
      </div>

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
        <section aria-labelledby="judge-report-parameters" className="min-w-0 lg:col-span-2">
          <h3 id="judge-report-parameters" className="text-sm font-semibold text-ink">
            Performance by evaluation parameter
          </h3>
          <table className="mt-2 w-full text-sm">
            <thead className="text-xs text-muted">
              <tr>
                <th scope="col" className="py-2 pr-3 text-left font-medium">
                  Parameter
                </th>
                <th scope="col" className="py-2 pr-6 text-right font-medium">
                  Calls
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  Agreement
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.key} className="border-t border-line">
                  <th scope="row" className="py-2.5 pr-3 text-left font-normal text-ink">
                    {p.label}
                  </th>
                  <td className="py-2.5 pr-6 text-right text-muted tabular">{p.total}</td>
                  <td className="py-2.5">
                    <span className="flex items-center justify-end gap-3">
                      {p.needs_improvement && (
                        <>
                          <AlertTriangle size={13} className="text-critical" aria-hidden />
                          <span className="sr-only">Needs improvement: </span>
                        </>
                      )}
                      <RateBar rate={p.rate} small={p.total < MIN_BASE} weak={p.needs_improvement} />
                      <span className={`w-12 text-right tabular ${p.total < MIN_BASE ? "text-muted" : "text-ink"} ${p.needs_improvement ? "font-semibold" : ""}`}>
                        {formatRate(p.rate)}
                      </span>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section aria-labelledby="judge-report-insights" className="min-w-0 rounded-xl bg-sunken p-4">
          <h3 id="judge-report-insights" className="text-sm font-semibold text-ink">
            What does this tell you?
          </h3>
          <ul className="mt-3 flex list-disc flex-col gap-2.5 pl-4 text-sm text-ink-2 marker:text-muted">
            {report.insights.map((insight) => (
              <li key={insight}>{insight}</li>
            ))}
          </ul>
        </section>
      </div>

      <p className="text-xs text-muted">Each reviewer's answer is compared with the stored audit they reviewed. A metric agrees within one scale point.</p>
    </div>
  );
}

export function JudgeEvaluation() {
  const query = useQuery({ queryKey: ["judge-report"], queryFn: spotCheckApi.report, enabled: false });
  const report = query.data;
  const busy = query.isFetching;
  return (
    <Card
      title="AI Judge Evaluation Report"
      action={
        report?.early_signal ? (
          <Badge tone="warning" icon={AlertTriangle}>
            Early signal
          </Badge>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="min-w-0 text-sm text-ink-2">
            {report ? (
              <>
                Generated {formatGeneratedAt(report.generated_at)}
                {report.judge_prompt_versions.length ? ` · Judge prompt ${report.judge_prompt_versions.join(", ")}` : ""}
              </>
            ) : (
              "How often reviewers agree with the AI judge, from the latest Golden Set results."
            )}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant={report ? "secondary" : "primary"} compact onClick={() => query.refetch()} disabled={busy}>
              {report && <RefreshCw size={14} className={busy ? "animate-spin motion-reduce:animate-none" : ""} aria-hidden />}
              {busy ? "Generating…" : report ? "Generate again" : "Generate Evaluation Report"}
            </Button>
            {report && report.calls > 0 && (
              <Button compact onClick={() => downloadPdf(report)}>
                <Download size={14} aria-hidden />
                Download PDF
              </Button>
            )}
          </div>
        </div>
        {query.isError && <ErrorNote>Couldn't generate the report: {(query.error as Error).message}. Try again.</ErrorNote>}
        {report && (
          <div className="enter-settle">
            <p role="status" className="sr-only">
              Report generated.
            </p>
            <Report report={report} />
          </div>
        )}
      </div>
    </Card>
  );
}

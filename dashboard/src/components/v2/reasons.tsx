import { ChevronRight, XCircle } from "lucide-react";
import type { AuditContext, AuditResultV2, CheckCode, MetricOutcome } from "../../api";
import { Badge, Card, humanize } from "../ui";
import { sortMetrics } from "../../lib/v2-logic";
import { EvidenceList } from "./evidence";
import { CHECK_NAME, CheckBadge } from "./verdict";

/** PRD §5 items 2, 3 and 5: why the tiles say what they say. Every deduction cites its turns. */

const CHECKS: CheckCode[] = ["S1", "S2", "S3", "S4"];
const SEVERITY_LABEL = { critical: "Critical", major: "Major", minor: "Minor" } as const;

/** S1–S4, each with its one-line reason; a failed check opens on its evidence and the flags that failed it. */
export function SystemChecks({ r, context }: { r: AuditResultV2; context: AuditContext }) {
  const label = (code: string) => context.conditions.find((c) => c.code === code)?.label ?? humanize(code);
  return (
    <Card title="System checks">
      <ul className="flex flex-col divide-y divide-line">
        {CHECKS.map((code) => {
          const c = r.checks[code];
          return (
            <li key={code} className="py-2.5 first:pt-0 last:pb-0">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-sm font-medium text-ink">
                    {code} {CHECK_NAME[code]}
                  </h3>
                  <p className="mt-0.5 text-sm text-ink-2">{c.reason}</p>
                </div>
                <CheckBadge result={c.result} />
              </div>
              {(c.flags ?? []).length > 0 && <p className="mt-1 text-xs text-muted">Failed by {c.flags!.map(label).join(", ")}</p>}
              {c.result === "FAIL" && c.evidence.length > 0 && (
                <div className="mt-2">
                  <EvidenceList evidence={c.evidence} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function MetricBar({ m }: { m: MetricOutcome }) {
  if (m.n_a || m.score === null) return <span className="block h-1.5 w-full rounded-full bg-sunken" aria-hidden />;
  const score = m.zeroed_by ? 0 : m.score;
  const share = score / m.max;
  const fill = share >= 0.75 ? "bg-accent" : share >= 0.5 ? "bg-warning" : "bg-critical";
  return (
    <span className="block h-1.5 w-full rounded-full bg-accent-track" aria-hidden>
      {score > 0 && <span className={`block h-1.5 rounded-full ${fill}`} style={{ width: `${share * 100}%` }} />}
    </span>
  );
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** The scorecard, lowest first; each metric expands to its rubric, the reason for its score and the evidence. */
export function Scorecard({ r, context }: { r: AuditResultV2; context: AuditContext }) {
  const defs = new Map(context.metrics.map((m) => [m.key, m]));
  const custom = context.metrics.some((m) => (r.weights_used[m.key] ?? 0) !== m.weight);
  return (
    <Card
      title="Scorecard"
      action={
        <span className="text-xs text-muted">
          {context.scorecard ? `${context.scorecard.name} v${context.scorecard.version} · ` : ""}
          {custom ? "custom weights" : "default weights"}
        </span>
      }
    >
      <ul className="flex flex-col divide-y divide-line">
        {sortMetrics(r.metrics).map((m) => {
          const def = defs.get(m.key);
          const weight = r.weights_used[m.key] ?? 0;
          const na = m.n_a || m.score === null;
          return (
            <li key={m.key}>
              <details className="group py-2">
                <summary className="grid cursor-pointer list-none grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1.5 rounded-md py-1 focus-visible:outline-2 focus-visible:outline-focus [&::-webkit-details-marker]:hidden">
                  <ChevronRight
                    size={14}
                    className="text-muted transition-transform duration-(--motion-fast) ease-snap group-open:rotate-90 motion-reduce:transition-none"
                    aria-hidden
                  />
                  <span className="min-w-0 truncate text-sm font-medium text-ink">
                    {m.name}
                    <span className="ml-2 text-xs font-normal text-muted tabular">{fmt(weight)}%</span>
                  </span>
                  <span className="text-sm font-semibold text-ink tabular">
                    {na ? <span className="font-normal text-muted">N/A</span> : `${fmt(m.zeroed_by ? 0 : m.score!)} / ${m.max}`}
                  </span>
                  <span aria-hidden />
                  <span className="col-span-2 flex items-center gap-2">
                    <MetricBar m={m} />
                    {m.zeroed_by && (
                      <Badge tone="critical" icon={XCircle}>
                        Zeroed by {context.conditions.find((c) => c.code === m.zeroed_by)?.label ?? humanize(m.zeroed_by)}
                      </Badge>
                    )}
                  </span>
                </summary>
                <div className="mt-2 ml-6 flex flex-col gap-2 text-sm">
                  <p className="text-ink-2">{m.reason}</p>
                  {m.zeroed_by && (
                    <p className="text-xs text-muted">The judge scored it {fmt(m.score!)}; the flag sets it to 0 in the score.</p>
                  )}
                  <EvidenceList evidence={m.evidence} />
                  {def && (
                    <div className="rounded-md bg-sunken p-3 text-xs text-ink-2">
                      <p className="text-ink">{def.rubric.checks}</p>
                      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                        {([0, 5, 10] as const).map((k) => (
                          <div key={k} className="contents">
                            <dt className="text-muted tabular">{(k / 10) * def.scale}</dt>
                            <dd>{def.rubric.anchors[k]}</dd>
                          </div>
                        ))}
                        <dt className="text-muted">N/A</dt>
                        <dd>{def.applicability || "Always applies"}</dd>
                      </dl>
                    </div>
                  )}
                </div>
              </details>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/** Failure conditions that were flagged, with their definition and every cited turn. Hidden when none were. */
export function Flags({ r, context }: { r: AuditResultV2; context: AuditContext }) {
  if (r.flags.length === 0) return null;
  const defs = new Map(context.conditions.map((c) => [c.code, c]));
  return (
    <Card title={`Failure conditions · ${r.flags.length}`}>
      <ul className="flex flex-col divide-y divide-line">
        {r.flags.map((f) => {
          const def = defs.get(f.code);
          return (
            <li key={f.code} className="py-2.5 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-medium text-ink">{def?.label ?? humanize(f.code)}</h3>
                <Badge tone={f.severity === "minor" ? "neutral" : "critical"} icon={XCircle}>
                  {SEVERITY_LABEL[f.severity]}
                </Badge>
                <span className="text-xs text-muted">{f.source === "rule" ? "rule check" : "judge"}</span>
              </div>
              <p className="mt-1 text-sm text-ink-2">{f.reason}</p>
              {def && (
                <details className="mt-1 text-xs">
                  <summary className="cursor-pointer text-muted hover:text-ink">What this flag means</summary>
                  <p className="mt-1 text-muted">{def.definition}</p>
                </details>
              )}
              <div className="mt-2">
                <EvidenceList evidence={f.evidence} />
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

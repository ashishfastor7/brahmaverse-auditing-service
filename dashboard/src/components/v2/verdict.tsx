import { AlertTriangle, CheckCircle2, Eye, MinusCircle, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import type { AuditContext, AuditResultV2, BusinessOutcome, CheckCode, CheckResult } from "../../api";
import { Badge, humanize } from "../ui";
import { TurnChips } from "./evidence";

/**
 * PRD §5 item 1: the four verdict tiles that answer "did this call pass, and why?" at a glance. The score leads (the
 * only figure at 30px); each tile carries its baseline: the pass threshold, the failed checks, the reason code, the
 * review threshold.
 */

export const CHECK_NAME: Record<CheckCode, string> = {
  S1: "Connected",
  S2: "Conversation handled",
  S3: "Flow completed",
  S4: "Data saved",
};

export const OUTCOME_LABEL: Record<BusinessOutcome, string> = {
  ACHIEVED: "Achieved",
  PARTIAL: "Partly achieved",
  NOT_ACHIEVED: "Not achieved",
  NOT_APPLICABLE: "Not applicable",
};

export function OutcomeBadge({ outcome }: { outcome: BusinessOutcome }) {
  if (outcome === "ACHIEVED")
    return (
      <Badge tone="good" icon={CheckCircle2}>
        {OUTCOME_LABEL[outcome]}
      </Badge>
    );
  if (outcome === "PARTIAL")
    return (
      <Badge tone="warning" icon={AlertTriangle}>
        {OUTCOME_LABEL[outcome]}
      </Badge>
    );
  if (outcome === "NOT_ACHIEVED")
    return (
      <Badge tone="warning" icon={AlertTriangle}>
        {OUTCOME_LABEL[outcome]}
      </Badge>
    );
  return (
    <Badge tone="neutral" icon={MinusCircle}>
      {OUTCOME_LABEL[outcome]}
    </Badge>
  );
}

export function CheckBadge({ result }: { result: CheckResult }) {
  if (result === "PASS")
    return (
      <Badge tone="good" icon={CheckCircle2}>
        Pass
      </Badge>
    );
  if (result === "FAIL")
    return (
      <Badge tone="critical" icon={XCircle}>
        Fail
      </Badge>
    );
  return (
    <Badge tone="neutral" icon={MinusCircle}>
      Not applicable
    </Badge>
  );
}

export function PassBadge({ passed }: { passed: boolean | null }) {
  if (passed === true)
    return (
      <Badge tone="good" icon={CheckCircle2}>
        Pass
      </Badge>
    );
  if (passed === false)
    return (
      <Badge tone="critical" icon={XCircle}>
        Fail
      </Badge>
    );
  return (
    <Badge tone="neutral" icon={MinusCircle}>
      No verdict
    </Badge>
  );
}

function Tile({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label} className="flex min-w-0 flex-col gap-1.5 rounded-xl bg-surface shadow-card px-4 py-3">
      <h2 className="text-xs text-muted">{label}</h2>
      {children}
    </section>
  );
}

/** The 0–100 score on one scale with the pass threshold marked; the fill is critical when the call failed. */
export function ScoreMeter({ score, threshold, passed }: { score: number | null; threshold: number; passed: boolean | null }) {
  return (
    <div
      className="relative mt-1 h-2 w-full rounded-full bg-accent-track"
      role="img"
      aria-label={`Score ${score ?? "none"} of 100, pass at ${threshold}`}
    >
      {score !== null && (
        <div className={`h-2 rounded-full ${passed === false ? "bg-critical" : "bg-accent"}`} style={{ width: `${Math.max(2, score)}%` }} />
      )}
      <div className="absolute -top-1 h-4 w-0.5 rounded-full bg-ink" style={{ left: `calc(${threshold}% - 1px)` }} aria-hidden />
    </div>
  );
}

export function VerdictTiles({ r, context }: { r: AuditResultV2; context: AuditContext }) {
  const threshold = context.scorecard?.pass_threshold ?? 0;
  const failedChecks = r.system_goal.failed;
  const goal = r.business_goal;
  const pct = Math.round(r.auditor_confidence * 100);
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Tile label="Score">
        <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
          <p className="text-3xl font-semibold whitespace-nowrap text-ink">
            {r.score === null ? "—" : r.score}
            <span className="ml-1 text-sm font-normal text-muted">/ 100</span>
          </p>
          <PassBadge passed={r.passed} />
        </div>
        <ScoreMeter score={r.score} threshold={threshold} passed={r.passed} />
        <p className="text-xs text-muted tabular">Pass at {threshold}</p>
        {/* P2-1: the weights this audit was scored with, next to the score. */}
        <details className="text-xs">
          <summary className="cursor-pointer text-muted hover:text-ink">
            {context.metrics.some((m) => (r.weights_used[m.key] ?? 0) !== m.weight) ? "Custom weights" : "Default weights"}
          </summary>
          <dl className="mt-1 grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5">
            {Object.entries(r.weights_used)
              .filter(([, w]) => w > 0)
              .sort(([, a], [, b]) => b - a)
              .map(([key, w]) => (
                <div key={key} className="contents">
                  <dt className="min-w-0 truncate text-ink-2">{context.metrics.find((m) => m.key === key)?.name ?? humanize(key)}</dt>
                  <dd className="text-right text-ink tabular">{w}%</dd>
                </div>
              ))}
          </dl>
        </details>
      </Tile>

      <Tile label="System goal">
        <div>
          <CheckBadge result={r.system_goal.result} />
        </div>
        <p className="text-xs text-ink-2">
          {failedChecks.length ? failedChecks.map((c) => `${c} ${CHECK_NAME[c]}`).join(", ") : "All checks passed"}
        </p>
      </Tile>

      <Tile label={context.goal ? `Business goal · ${context.goal.name}` : "Business goal"}>
        {goal ? (
          <>
            <div>
              <OutcomeBadge outcome={goal.outcome} />
            </div>
            <p className="text-xs text-ink-2">{humanize(goal.reason_code)}</p>
            {goal.required_outputs.length > 0 && (
              <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-2 gap-y-1 text-xs">
                {goal.required_outputs.map((o) => (
                  <div key={o.key} className="contents">
                    <dt className="text-muted">{humanize(o.key)}</dt>
                    <dd className="min-w-0 text-ink">
                      {o.value ?? <span className="text-muted">Not given</span>} <TurnChips turns={o.turns} />
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </>
        ) : (
          <p className="text-sm text-muted">—</p>
        )}
      </Tile>

      <Tile label="Auditor confidence">
        <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
          <p className="text-2xl font-semibold text-ink">{pct}%</p>
          {r.needs_review && (
            <Badge tone="warning" icon={Eye}>
              Needs review
            </Badge>
          )}
        </div>
        <p className="text-xs text-ink-2">
          {r.review_reasons.length ? r.review_reasons.join("; ") : `Transcript ${r.transcript_quality ?? "not rated"}`}
        </p>
      </Tile>
    </div>
  );
}

import { CheckCircle2, XCircle } from "lucide-react";
import { useId, useState } from "react";
import type { BlindAnswer, BlindItem, BusinessOutcome } from "../../api";
import { useUnsavedGuard } from "../admin";
import { Badge, Button, ErrorNote, humanize, Segmented, Textarea } from "../ui";
import { OUTCOME_LABEL } from "./verdict";

/**
 * P2-18: the blind spot-check. Two explicit variants instead of one component with a `revealed` flag:
 * `BlindForm` asks for the reviewer's own answer (the judge's verdict isn't on the page, or in the API response), and
 * `BlindReveal` shows both answers side by side once it's saved.
 */

export function BlindForm({
  options,
  saving,
  error,
  onSave,
}: {
  options: BlindItem["options"];
  saving: boolean;
  error: string | null;
  onSave: (answer: BlindAnswer) => void;
}) {
  const id = useId();
  const [passFail, setPassFail] = useState<"PASS" | "FAIL" | "">("");
  const [outcome, setOutcome] = useState<BusinessOutcome | "">("");
  const [codes, setCodes] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [tried, setTried] = useState(false);
  const [definitions, setDefinitions] = useState(false);
  // Started but not saved: ask before a link or closing the tab throws the answers away.
  useUnsavedGuard(!saving && Boolean(passFail || outcome || codes.length || note.trim()), "Leave this spot-check? Your answers aren't saved yet.");
  const missing = [!passFail && "pass or fail", !outcome && "the business outcome"].filter(Boolean) as string[];

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (missing.length || !passFail || !outcome) return;
        onSave({
          expected_pass_fail: passFail,
          expected_business_outcome: outcome,
          expected_failure_codes: codes,
          note: note.trim() || null,
        });
      }}
    >
      <div className="flex flex-col gap-1.5">
        <span id={`${id}-pf`} className="text-sm font-medium text-ink">
          Should this call pass?
        </span>
        <div aria-labelledby={`${id}-pf`}>
          <Segmented<"PASS" | "FAIL" | "">
            legend="Should this call pass?"
            value={passFail}
            options={[
              ["PASS", "Pass"],
              ["FAIL", "Fail"],
            ]}
            onChange={setPassFail}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-outcome`} className="text-sm font-medium text-ink">
          Business outcome
        </label>
        <select
          id={`${id}-outcome`}
          className="input max-w-xs"
          value={outcome}
          aria-invalid={tried && !outcome}
          onChange={(e) => setOutcome(e.target.value as BusinessOutcome)}
        >
          <option value="">Choose…</option>
          {options.outcomes.map((o) => (
            <option key={o} value={o}>
              {OUTCOME_LABEL[o]}
            </option>
          ))}
        </select>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-ink">Which failure conditions happened?</legend>
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
          Leave all unticked if none did.
          <button
            type="button"
            className="text-accent hover:underline"
            aria-expanded={definitions}
            onClick={() => setDefinitions((d) => !d)}
          >
            {definitions ? "Hide what each one means" : "Show what each one means"}
          </button>
        </p>
        <ul className="mt-1.5 flex flex-col gap-1">
          {options.failure_codes.map((c) => (
            <li key={c.code}>
              <label className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-1.5 hover:bg-sunken">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 accent-primary"
                  checked={codes.includes(c.code)}
                  onChange={(e) => setCodes((list) => (e.target.checked ? [...list, c.code] : list.filter((x) => x !== c.code)))}
                />
                <span className="min-w-0 text-sm">
                  <span className="text-ink">{c.label}</span>
                  {definitions && <span className="block text-xs text-muted">{c.definition}</span>}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-note`} className="text-sm font-medium text-ink">
          Note <span className="font-normal text-muted">(optional)</span>
        </label>
        <Textarea id={`${id}-note`} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>

      {tried && missing.length > 0 && <ErrorNote>Choose {missing.join(" and ")} before saving.</ErrorNote>}
      {error && <ErrorNote>{error}</ErrorNote>}
      <div>
        <Button variant="primary" type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save and show the judge's answer"}
        </Button>
      </div>
    </form>
  );
}

function Match({ ok }: { ok: boolean }) {
  return ok ? (
    <Badge tone="good" icon={CheckCircle2}>
      Same
    </Badge>
  ) : (
    <Badge tone="critical" icon={XCircle}>
      Different
    </Badge>
  );
}

const codesText = (codes: string[], labels: Map<string, string>) =>
  codes.length ? codes.map((c) => labels.get(c) ?? humanize(c)).join(", ") : "None";
const pf = (v: "PASS" | "FAIL" | null) => (v === "PASS" ? "Pass" : v === "FAIL" ? "Fail" : "—");

export function BlindReveal({ item, next }: { item: BlindItem; next: number | null }) {
  const rv = item.revealed!;
  const labels = new Map(item.options.failure_codes.map((c) => [c.code, c.label]));
  const rows: [string, string, string, boolean][] = [
    ["Pass or fail", pf(rv.review.expected_pass_fail), pf(rv.judge.pass_fail), rv.comparison.pass_fail],
    [
      "Business outcome",
      rv.review.expected_business_outcome ? OUTCOME_LABEL[rv.review.expected_business_outcome] : "—",
      rv.judge.business_outcome ? OUTCOME_LABEL[rv.judge.business_outcome] : "—",
      rv.comparison.business_outcome,
    ],
    [
      "Failure conditions",
      codesText(rv.review.expected_failure_codes ?? [], labels),
      codesText(rv.judge.failure_codes, labels),
      rv.comparison.failure_codes,
    ],
  ];
  const differ = rows.filter((r) => !r[3]).length;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-base font-semibold text-ink" role="status">
        {differ === 0 ? "You and the judge agree." : `You and the judge differ on ${differ} of 3.`}
      </p>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted">
            <th className="py-1.5 pr-3 font-normal">
              <span className="sr-only">Question</span>
            </th>
            <th className="py-1.5 pr-3 font-normal">You</th>
            <th className="py-1.5 pr-3 font-normal">Judge</th>
            <th className="py-1.5 font-normal">
              <span className="sr-only">Match</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([q, you, judge, ok]) => (
            <tr key={q} className="border-t border-line align-top">
              <th scope="row" className="py-2 pr-3 text-left font-medium text-ink">
                {q}
              </th>
              <td className="py-2 pr-3 text-ink">{you}</td>
              <td className="py-2 pr-3 text-ink">{judge}</td>
              <td className="py-2 text-right">
                <Match ok={ok} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-muted">
        Judge's score {rv.judge.score ?? "—"}
        {rv.judge.reason_code ? ` · ${humanize(rv.judge.reason_code)}` : ""} · saved by {rv.review.reviewer}
        {rv.review.note ? ` · “${rv.review.note}”` : ""}
      </p>
      <div className="flex flex-wrap gap-2">
        {next !== null && (
          <a href={`#/spot-check/${next}`} className="btn btn-primary btn-compact">
            Next call
          </a>
        )}
        <a href={`#/calls/${item.call_id}`} className="btn btn-secondary btn-compact">
          Open the full audit
        </a>
        <a href="#/spot-check" className="btn btn-ghost btn-compact">
          Back to this week's checks
        </a>
      </div>
    </div>
  );
}

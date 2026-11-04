import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Flag, MessageSquareWarning, Trash2 } from "lucide-react";
import { createContext, type ReactNode, use, useId, useRef, useState } from "react";
import {
  auditV2Api,
  type AuditView,
  type BusinessOutcome,
  type CheckCode,
  type CheckResult,
  type Review as ReviewRow,
  type ReviewInput,
} from "../../api";
import { Badge, Button, Card, Dialog, ErrorNote, formatDate, humanize, Segmented, Textarea } from "../ui";
import { CHECKS, disputeInput, type DisputeItem as Item, newItem, unchangedItems } from "../../lib/v2-logic";
import { CHECK_NAME, OUTCOME_LABEL } from "./verdict";

/**
 * P2-4, PRD §5 item 7: agree with the whole audit, dispute any number of items (each with the right answer and its
 * own note), or flag the call. Compound components over one provider: `Review.Provider` is the only place that knows
 * how a review is saved; the buttons and the history read it through context.
 *
 *   <Review.Provider view={view}>
 *     <Review.Actions />   (Agree · Dispute… · Flag…)
 *     <Review.History />
 *   </Review.Provider>
 */

type ReviewContextValue = {
  state: { saving: ReviewInput["verdict"] | null; saved: ReviewInput["verdict"] | null; error: string | null };
  actions: { save: (input: ReviewInput) => Promise<boolean> };
  meta: { view: AuditView };
};
const ReviewContext = createContext<ReviewContextValue | null>(null);
const useReview = () => {
  const ctx = use(ReviewContext);
  if (!ctx) throw new Error("Review.Provider missing");
  return ctx;
};

function Provider({ view, children }: { view: AuditView; children: ReactNode }) {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: (input: ReviewInput) => auditV2Api.review(view.audit.id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["v2-audit"] }),
  });
  const value: ReviewContextValue = {
    state: {
      saved: mutation.isSuccess ? mutation.data.verdict : null,
      saving: mutation.isPending ? (mutation.variables?.verdict ?? null) : null,
      error: mutation.error ? (mutation.error as Error).message : null,
    },
    actions: {
      save: (input) =>
        mutation.mutateAsync(input).then(
          () => true,
          () => false,
        ),
    },
    meta: { view },
  };
  return <ReviewContext value={value}>{children}</ReviewContext>;
}

function Agree() {
  const { state, actions } = useReview();
  return (
    <Button compact onClick={() => actions.save({ verdict: "agree" })} disabled={state.saving !== null}>
      <CheckCircle2 size={14} aria-hidden />
      {state.saving === "agree" ? "Saving…" : "Agree"}
    </Button>
  );
}

// ---- Dispute: pick items, give each the right answer and a note ----

const RESULT_LABEL: Record<CheckResult, string> = { PASS: "Pass", FAIL: "Fail", NOT_APPLICABLE: "N/A" };

/** Everything a reviewer can dispute, as [item key, label] options, minus what's already in the dispute. */
function choices(view: AuditView, taken: Set<string>) {
  const r = view.audit.result!;
  const flagged = new Set(r.flags.map((f) => f.code));
  const label = (code: string) => view.context.conditions.find((c) => c.code === code)?.label ?? humanize(code);
  const groups: [string, [string, string][]][] = [
    ["Metrics", r.metrics.map((m) => [`metric:${m.key}`, m.name])],
    ["System checks", CHECKS.map((c) => [`check:${c}`, `${c} ${CHECK_NAME[c]}`])],
    ["Business goal", r.business_goal ? [["business_outcome", "Business outcome"]] : []],
    ["Flagged, but didn't happen", [...flagged].map((c) => [`code:${c}`, label(c)])],
    [
      "Happened, but wasn't flagged",
      view.context.conditions.filter((c) => c.enabled && !flagged.has(c.code)).map((c) => [`code:${c.code}`, c.label]),
    ],
  ];
  return groups.map(([g, opts]) => [g, opts.filter(([k]) => !taken.has(k))] as const).filter(([, opts]) => opts.length > 0);
}

function ItemEditor({
  item,
  view,
  onChange,
  onRemove,
}: {
  item: Item;
  view: AuditView;
  onChange: (i: Item) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const r = view.audit.result!;
  const flagged = r.flags.some((f) => item.kind === "code" && f.code === item.code);
  let title: string;
  let current: string;
  let control: ReactNode = null;
  if (item.kind === "metric") {
    const m = r.metrics.find((x) => x.key === item.metric)!;
    title = m.name;
    current = m.n_a || m.score === null ? "N/A" : `${m.zeroed_by ? 0 : m.score} / ${m.max}`;
    control = (
      <select
        id={`${id}-v`}
        className="input input-compact w-28"
        value={item.value}
        onChange={(e) => onChange({ ...item, value: e.target.value })}
      >
        {Array.from({ length: m.max + 1 }, (_, n) => (
          <option key={n} value={String(n)}>
            {n} / {m.max}
          </option>
        ))}
        <option value="na">N/A</option>
      </select>
    );
  } else if (item.kind === "check") {
    title = `${item.check} ${CHECK_NAME[item.check]}`;
    current = RESULT_LABEL[r.checks[item.check].result];
    control = (
      <Segmented<CheckResult>
        legend={`Right result for ${title}`}
        value={item.value}
        options={(["PASS", "FAIL", "NOT_APPLICABLE"] as const).map((v) => [v, RESULT_LABEL[v]])}
        onChange={(v) => onChange({ ...item, value: v })}
      />
    );
  } else if (item.kind === "outcome") {
    title = "Business outcome";
    current = OUTCOME_LABEL[r.business_goal!.outcome];
    control = (
      <select
        id={`${id}-v`}
        className="input input-compact w-44"
        value={item.value}
        onChange={(e) => onChange({ ...item, value: e.target.value as BusinessOutcome })}
      >
        {(view.context.goal?.outcomes ?? []).map((o) => (
          <option key={o} value={o}>
            {OUTCOME_LABEL[o]}
          </option>
        ))}
      </select>
    );
  } else {
    title = view.context.conditions.find((c) => c.code === item.code)?.label ?? humanize(item.code);
    current = flagged ? "Flagged" : "Not flagged";
  }
  const answer = item.kind === "code" ? (flagged ? "Didn't happen: remove the flag" : "Happened: add the flag") : null;
  return (
    <li className="enter-settle rounded-lg border border-line p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink">{title}</p>
          <p className="text-xs text-muted">Audit says: {current}</p>
        </div>
        <Button variant="ghost" compact onClick={onRemove} aria-label={`Remove ${title} from the dispute`}>
          <Trash2 size={14} aria-hidden />
        </Button>
      </div>
      <div className="mt-2 flex flex-col gap-2">
        {control && (
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor={`${id}-v`} className="text-xs text-muted">
              Right answer
            </label>
            {control}
          </div>
        )}
        {answer && <p className="text-sm text-ink">{answer}</p>}
        <label htmlFor={`${id}-n`} className="sr-only">
          Why ({title})
        </label>
        <Textarea
          id={`${id}-n`}
          rows={2}
          placeholder="Why? Cite the turn if you can."
          value={item.note}
          onChange={(e) => onChange({ ...item, note: e.target.value })}
        />
      </div>
    </li>
  );
}

function Dispute() {
  const { state, actions, meta } = useReview();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [note, setNote] = useState("");
  const pickId = useId();
  const [picked, setPicked] = useState("");
  const pickRef = useRef<HTMLSelectElement>(null);
  const groups = choices(meta.view, new Set(items.map((i) => i.key)));
  const close = () => {
    setOpen(false);
    setItems([]);
    setNote("");
    setPicked("");
  };
  const add = () => {
    if (!picked) return;
    setItems((list) => [...list, newItem(picked, meta.view)]);
    setPicked("");
  };
  const unchanged = unchangedItems(items, meta.view);
  return (
    <>
      <Button compact onClick={() => setOpen(true)} disabled={state.saving !== null}>
        <MessageSquareWarning size={14} aria-hidden />
        Dispute…
      </Button>
      <Dialog
        open={open}
        onClose={close}
        size="wide"
        title="Dispute this audit"
        footer={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button
              variant="primary"
              disabled={items.length === 0 || unchanged.length > 0 || state.saving !== null}
              onClick={async () => (await actions.save(disputeInput(items, meta.view, note))) && close()}
            >
              {state.saving === "dispute" ? "Saving…" : items.length > 1 ? `Save dispute (${items.length} items)` : "Save dispute"}
            </Button>
          </>
        }
      >
        <p>Add each thing the audit got wrong and give the right answer. Disputes become test cases the judge is checked against.</p>
        {groups.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={pickId} className="text-sm font-medium text-ink">
              What's wrong?
            </label>
            <div className="flex gap-2">
              <select
                ref={pickRef}
                id={pickId}
                data-autofocus
                className="input min-w-0 flex-1"
                value={picked}
                onChange={(e) => setPicked(e.target.value)}
              >
                <option value="">Choose a metric, check, outcome or flag…</option>
                {groups.map(([g, opts]) => (
                  <optgroup key={g} label={g}>
                    {opts.map(([k, l]) => (
                      <option key={k} value={k}>
                        {l}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <Button onClick={add} disabled={!picked}>
                Add
              </Button>
            </div>
          </div>
        )}
        {items.length > 0 && (
          <ul className="flex flex-col gap-2">
            {items.map((item) => (
              <ItemEditor
                key={item.key}
                item={item}
                view={meta.view}
                onChange={(next) => setItems((list) => list.map((i) => (i.key === item.key ? next : i)))}
                onRemove={() => {
                  setItems((list) => list.filter((i) => i.key !== item.key));
                  pickRef.current?.focus();
                }}
              />
            ))}
          </ul>
        )}
        {unchanged.length > 0 && (
          <p className="text-sm text-ink">
            Change the answer for {unchanged.map((i) => itemLabel(i.key, meta.view)).join(", ")}, or remove it.
          </p>
        )}
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${pickId}-note`} className="text-sm font-medium text-ink">
            Overall note <span className="font-normal text-muted">(optional)</span>
          </label>
          <Textarea id={`${pickId}-note`} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        {state.error && <ErrorNote>{state.error}</ErrorNote>}
      </Dialog>
    </>
  );
}

function FlagForReview() {
  const { state, actions } = useReview();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const id = useId();
  const close = () => {
    setOpen(false);
    setNote("");
  };
  return (
    <>
      <Button compact variant="ghost" onClick={() => setOpen(true)} disabled={state.saving !== null}>
        <Flag size={14} aria-hidden />
        Flag…
      </Button>
      <Dialog
        open={open}
        onClose={close}
        title="Flag for review"
        footer={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button
              variant="primary"
              disabled={state.saving !== null}
              onClick={async () => (await actions.save({ verdict: "flag", note: note.trim() || null })) && close()}
            >
              {state.saving === "flag" ? "Saving…" : "Flag for review"}
            </Button>
          </>
        }
      >
        <p>For a call someone else should look at. A flag doesn't change the audit or the golden set.</p>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={id} className="text-sm font-medium text-ink">
            What should they look at? <span className="font-normal text-muted">(optional)</span>
          </label>
          <Textarea id={id} data-autofocus rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        {state.error && <ErrorNote>{state.error}</ErrorNote>}
      </Dialog>
    </>
  );
}

function Actions() {
  const { state } = useReview();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <Agree />
        <Dispute />
        <FlagForReview />
      </div>
      {state.error && state.saving === null && <ErrorNote>{state.error}</ErrorNote>}
      <p role="status" className="text-xs text-muted">
        {state.saved ? `Review saved: ${VERDICT[state.saved].label.toLowerCase()}.` : ""}
      </p>
    </div>
  );
}

const VERDICT = {
  agree: { tone: "good", icon: CheckCircle2, label: "Agreed" },
  dispute: { tone: "critical", icon: MessageSquareWarning, label: "Disputed" },
  flag: { tone: "warning", icon: Flag, label: "Flagged" },
} as const;

function itemLabel(key: string, view: AuditView) {
  const [kind, rest] = key.includes(":") ? (key.split(":") as [string, string]) : [key, ""];
  if (kind === "metric") return view.audit.result?.metrics.find((m) => m.key === rest)?.name ?? humanize(rest);
  if (kind === "check") return `${rest} ${CHECK_NAME[rest as CheckCode]}`;
  if (kind === "code") return view.context.conditions.find((c) => c.code === rest)?.label ?? humanize(rest);
  return "Business outcome";
}

function changes(review: ReviewRow, view: AuditView): { key: string; answer: string }[] {
  const out: { key: string; answer: string }[] = [];
  for (const [k, v] of Object.entries(review.corrected_scores ?? {}))
    out.push({ key: `metric:${k}`, answer: v === null ? "N/A" : String(v) });
  for (const [k, v] of Object.entries(review.corrected_checks ?? {}))
    out.push({ key: `check:${k}`, answer: RESULT_LABEL[v as CheckResult] });
  if (review.expected_business_outcome) out.push({ key: "business_outcome", answer: OUTCOME_LABEL[review.expected_business_outcome] });
  if (review.expected_failure_codes) {
    const flagged = view.audit.result?.flags.map((f) => f.code) ?? [];
    for (const c of flagged) if (!review.expected_failure_codes.includes(c)) out.push({ key: `code:${c}`, answer: "didn't happen" });
    for (const c of review.expected_failure_codes) if (!flagged.includes(c)) out.push({ key: `code:${c}`, answer: "happened" });
  }
  return out;
}

function History() {
  const { meta } = useReview();
  const reviews = meta.view.reviews;
  // Reviews already there when the page opened don't animate; one saved now settles in, to confirm the save.
  const atOpen = useRef(new Set(reviews.map((r) => r.id)));
  if (reviews.length === 0) return <p className="text-sm text-muted">No reviews yet.</p>;
  return (
    <ol className="flex flex-col divide-y divide-line">
      {reviews.map((r) => {
        const v = VERDICT[r.verdict];
        return (
          <li key={r.id} className={`py-2.5 text-sm first:pt-0 last:pb-0 ${atOpen.current.has(r.id) ? "" : "enter-settle"}`}>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={v.tone} icon={v.icon}>
                {v.label}
              </Badge>
              <span className="text-xs text-muted">
                {r.reviewer} · {formatDate(r.created_at)}
              </span>
            </div>
            {changes(r, meta.view).length > 0 && (
              <ul className="mt-1.5 flex flex-col gap-1">
                {changes(r, meta.view).map((c) => (
                  <li key={c.key} className="text-ink-2">
                    <span className="text-ink">{itemLabel(c.key, meta.view)}</span>: {c.answer}
                    {r.item_notes?.[c.key] && <span className="block text-xs text-muted">{r.item_notes[c.key]}</span>}
                  </li>
                ))}
              </ul>
            )}
            {r.note && <p className="mt-1 text-ink-2">{r.note}</p>}
          </li>
        );
      })}
    </ol>
  );
}

/** The review card the call page shows beside a current, completed audit. */
export function ReviewCard({ view }: { view: AuditView }) {
  return (
    <Review.Provider view={view}>
      <Card title="Your review">
        <div className="flex flex-col gap-4">
          <Review.Actions />
          <Review.History />
        </div>
      </Card>
    </Review.Provider>
  );
}

export const Review = { Provider, Actions, Agree, Dispute, Flag: FlagForReview, History };

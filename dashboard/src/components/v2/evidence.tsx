import { createContext, type ReactNode, use, useCallback, useEffect, useRef, useState } from "react";
import type { StoredEvidence, Turn } from "../../api";
import { humanize } from "../ui";

/**
 * Evidence links and the transcript they point into (PRD §5 items 5–6). Any chip anywhere on the page calls `jump`,
 * which scrolls the transcript to the turn and flashes it; the transcript marks every flagged turn with the names of
 * what cited it. A copy of the v1 page's pattern (`CallDetail.tsx` stays untouched).
 */

/** The turn last jumped to, with a counter so jumping to the same turn again re-runs the flash. */
type ActiveTurn = { turn: number; n: number } | null;

// Two contexts: chips only need the stable `jump`, so a jump re-renders the transcript and not every chip on the page.
const JumpContext = createContext<((turn: number) => void) | null>(null);
const ActiveTurnContext = createContext<ActiveTurn>(null);

export function TranscriptProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<ActiveTurn>(null);
  const jump = useCallback((turn: number) => setActive((a) => ({ turn, n: (a?.n ?? 0) + 1 })), []);
  return (
    <JumpContext value={jump}>
      <ActiveTurnContext value={active}>{children}</ActiveTurnContext>
    </JumpContext>
  );
}

/** One chip per turn: "#13". Pressing it scrolls the transcript there. */
export function TurnChips({ turns }: { turns: number[] }) {
  const jump = use(JumpContext);
  if (!jump) throw new Error("TranscriptProvider missing");
  if (turns.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap gap-1 align-middle">
      {[...new Set(turns)].map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => jump(t)}
          aria-label={`Show turn ${t} in the transcript`}
          className="min-h-6 rounded bg-sunken px-1.5 text-xs text-ink-2 tabular transition-[background-color,color,transform] duration-(--motion-fast) ease-snap active:scale-[0.97] motion-reduce:active:scale-100 hover:bg-accent-track hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
        >
          #{t}
        </button>
      ))}
    </span>
  );
}

/** A cited quote with its turn chips; flags quotes it couldn't find (the auditor may have paraphrased). */
export function EvidenceList({ evidence }: { evidence: StoredEvidence[] }) {
  if (evidence.length === 0) return null;
  return (
    <ul className="flex flex-col gap-2">
      {evidence.map((e, i) => (
        <li key={i} className="flex flex-col items-start gap-1 text-sm">
          {e.quote && <q className="text-ink-2">{e.quote}</q>}
          <TurnChips turns={e.turns} />
        </li>
      ))}
    </ul>
  );
}

/** Turn number → what cited it (metric names, check codes, condition codes), for the inline marks (P2-2). */
export type TurnMarks = Map<number, string[]>;

export function addMarks(marks: TurnMarks, turns: number[], label: string) {
  for (const t of turns) {
    const list = marks.get(t) ?? [];
    if (!list.includes(label)) list.push(label);
    marks.set(t, list);
  }
}

const NO_MARKS: TurnMarks = new Map();
const speaker = (s: string) => (s === "agent" ? "Agent" : s === "user" ? "Caller" : humanize(s));

/** The transcript; flagged turns carry their marks, the jumped-to turn flashes once. */
export function Transcript({ turns, marks = NO_MARKS }: { turns: Turn[]; marks?: TurnMarks }) {
  const active = use(ActiveTurnContext);
  const refs = useRef(new Map<number, HTMLLIElement>());
  useEffect(() => {
    if (!active) return;
    const el = refs.current.get(active.turn);
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
    el.focus({ preventScroll: true });
  }, [active]);

  if (turns.length === 0) return <p className="text-sm text-muted">No transcript for this call.</p>;
  return (
    <ol aria-label="Transcript" className="flex max-h-[70vh] flex-col gap-0.5 overflow-y-auto pr-1">
      {turns.map((t) => {
        const labels = marks.get(t.turn);
        return (
          <li
            key={active?.turn === t.turn ? `${t.turn}-${active.n}` : t.turn}
            ref={(el) => {
              if (el) refs.current.set(t.turn, el);
            }}
            tabIndex={-1}
            className={`grid grid-cols-[2.25rem_3.5rem_1fr] gap-x-2 rounded-md px-2 py-1.5 text-sm outline-none focus-visible:outline-2 focus-visible:outline-focus ${
              labels ? "border-l-2 border-accent" : "border-l-2 border-transparent"
            } ${active?.turn === t.turn ? "turn-flash" : ""}`}
          >
            <span className="pt-0.5 text-xs text-muted tabular">{t.turn}</span>
            <span className={`pt-0.5 text-xs font-medium ${t.speaker === "agent" ? "text-accent" : "text-ink-2"}`}>
              {speaker(t.speaker)}
            </span>
            <span className="min-w-0 text-ink">
              {t.text}
              {labels && (
                <span className="mt-1 flex flex-wrap gap-1">
                  {labels.map((l) => (
                    <span key={l} className="rounded border border-line bg-surface px-1.5 text-xs text-ink-2">
                      {l}
                    </span>
                  ))}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

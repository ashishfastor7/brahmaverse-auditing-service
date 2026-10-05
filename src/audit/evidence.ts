import { normalizeLine } from "./rules";
import type { Turn } from "./types";

/**
 * Checks that a quote the judge cited really is in the transcript — an auditor that invents its
 * own evidence is worse than none. Matching ignores case and punctuation. A quote is split into
 * pieces at "..." and at sentence ends, and matches a turn containing every piece — so a quote
 * that skips a sentence of a long turn still counts, but reworded text never does. A quote found
 * on a different turn than cited is accepted, with the turn corrected.
 */
export function locateQuote(transcript: Turn[], turn: number, quote: string): { turn: number; valid: boolean } {
  const pieces = quote
    .split(/\.{3}|…|(?<=[.!?])\s+/)
    .map(normalizeLine)
    .filter((p) => p.length > 0);
  if (pieces.length === 0) return { turn, valid: false };

  const matches = (t: Turn) => {
    const text = normalizeLine(t.text);
    return pieces.every((p) => text.includes(p));
  };

  const cited = transcript.find((t) => t.turn === turn);
  if (cited && matches(cited)) return { turn, valid: true };
  const elsewhere = transcript.find(matches);
  if (elsewhere) return { turn: elsewhere.turn, valid: true };
  return { turn, valid: false };
}

/** Validates (and corrects the turn of) every cited item in place; returns the share that was valid. */
export function validateEvidence(transcript: Turn[], items: { turn: number; quote: string; valid?: boolean }[]): number {
  if (items.length === 0) return 1;
  let valid = 0;
  for (const item of items) {
    const found = locateQuote(transcript, item.turn, item.quote);
    item.turn = found.turn;
    item.valid = found.valid;
    if (found.valid) valid++;
  }
  return valid / items.length;
}

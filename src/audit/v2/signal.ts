/**
 * What every deterministic v2 check and signal returns (PRD §3.1, §4.3, §7): a result, the measured value, and the
 * turns that back it. Transcripts have no per-turn timing (gap analysis, "Call data format"), so `ts_start` and
 * `ts_end` are null until a timing source exists (P0-5).
 */
export type SignalResult = "pass" | "fail" | "na";
export type SignalEvidence = { turns: number[]; ts_start: number | null; ts_end: number | null };
export type Signal<V> = { result: SignalResult; value: V; evidence: SignalEvidence[] };
/** A system check (S1–S4) also says why, in one line, for the call page (PRD §5 item 2). */
export type Check<V> = Signal<V> & { reason: string };

/** Evidence for some turns, with no timing. */
export const turnsEvidence = (turns: number[]): SignalEvidence => ({ turns, ts_start: null, ts_end: null });

import type { Turn } from "@/audit/types";
import { z } from "zod";
import type { CallRecord } from "./call-record";
import { turnsEvidence, type Signal } from "./signal";

/**
 * P1-10 and P1-11 (PRD §4.3): transcript-only signals for the rule and hybrid metrics. Pure. Every threshold comes
 * from the metric's `params` (seeded in migration 0011); parse them with the schemas below before calling.
 */

export const RepetitionParams = z.object({
  /** Dice similarity (0–1) of character trigrams at which two agent turns count as the same line. */
  similarity: z.number().min(0).max(1),
  /** Times a line must be said for Repetition (and the S2 loop rule) to fail. */
  min_repeats: z.number().int().min(2),
  /** Shorter lines ("okay", "got it") legitimately repeat and are ignored. */
  min_chars: z.number().int().min(0),
  /** S2 loop rule only: a repeat after a caller reply this short (or none) is a re-ask, not a loop. */
  unclear_reply_max_words: z.number().int().min(0),
});
export type RepetitionParams = z.infer<typeof RepetitionParams>;

export const StallingFillerParams = z.object({
  stalling_phrases: z.array(z.string()),
  filler_words: z.array(z.string()),
  /** Bands for (stalling phrases + filler words) per 100 agent words: ≤ full is full marks, ≤ partial is partial. */
  per_100_words: z.object({ full: z.number().min(0), partial: z.number().min(0) }),
  /** Under this many agent words the metric is N/A. */
  min_agent_words: z.number().int().min(0),
});
export type StallingFillerParams = z.infer<typeof StallingFillerParams>;

export const LanguageParams = z.object({
  /** Turns with fewer words are `und` ("Yes", "Haan", "Hello"). */
  min_words: z.number().int().min(1),
  /** A Latin-script turn is Hindi when at least this share of its words is on `romanised_hindi_words`. */
  hindi_ratio: z.number().min(0).max(1),
  /** Consecutive caller turns in a new language before the caller counts as having switched. */
  switch_turns: z.number().int().min(1),
  /** Consecutive agent turns not in the caller's language that fail the check. */
  mismatch_turns: z.number().int().min(1),
  /** Common romanised Hindi words that are not also English words. */
  romanised_hindi_words: z.array(z.string()),
});
export type LanguageParams = z.infer<typeof LanguageParams>;

/**
 * Like v1's `normalizeLine`, but keeps combining marks: Devanagari vowel signs are marks, and dropping them splits
 * "मेरा" into "म र".
 */
export const normalizeText = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const words = (text: string) => normalizeText(text).split(" ").filter(Boolean);
const agentTurns = (record: CallRecord) => record.transcript.filter((t) => t.speaker === "agent");

function trigrams(text: string): Map<string, number> {
  const chars = Array.from(` ${normalizeText(text)} `);
  const grams = new Map<string, number>();
  for (let i = 0; i + 3 <= chars.length; i++) {
    const g = chars.slice(i, i + 3).join("");
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  return grams;
}

/** Dice coefficient of character trigrams, 0–1; works for any script. */
export function lineSimilarity(a: string, b: string): number {
  const ga = trigrams(a);
  const gb = trigrams(b);
  let shared = 0;
  let total = 0;
  for (const [g, n] of ga) {
    shared += Math.min(n, gb.get(g) ?? 0);
    total += n;
  }
  for (const n of gb.values()) total += n;
  return total === 0 ? 0 : (2 * shared) / total;
}

export type TurnGroup = { turns: number[]; similarity: number };

/** Agent turns long enough to count as a line (`min_chars`); shorter ones ("okay", "got it") legitimately repeat. */
export const agentLines = (turns: Turn[], minChars: number) =>
  turns.filter((t) => t.speaker === "agent" && normalizeText(t.text).length >= minChars);

/**
 * Agent turns that say the same line: two turns are linked when their similarity is `params.similarity` or above,
 * and a group is everything linked together, so "… is that right?" and "… is that correct?" variants stay in one
 * group. Only groups of two or more are returned, in turn order; `similarity` is the weakest link in the group.
 */
export function similarAgentTurns(turns: Turn[], params: Pick<RepetitionParams, "similarity" | "min_chars">): TurnGroup[] {
  const lines = agentLines(turns, params.min_chars);
  const parent = lines.map((_, i) => i);
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  const weakest = new Map<number, number>();
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const s = lineSimilarity(lines[i].text, lines[j].text);
      if (s < params.similarity) continue;
      const [a, b] = [root(i), root(j)];
      const link = Math.min(s, weakest.get(a) ?? 1, weakest.get(b) ?? 1);
      parent[b] = a;
      weakest.set(a, link);
    }
  }
  const groups = new Map<number, number[]>();
  lines.forEach((t, i) => groups.set(root(i), [...(groups.get(root(i)) ?? []), t.turn]));
  return [...groups]
    .filter(([, g]) => g.length >= 2)
    .map(([r, g]) => ({ turns: g, similarity: Math.round((weakest.get(r) ?? 1) * 100) / 100 }));
}

export type RepetitionValue = { groups: TurnGroup[]; max_repeats: number };

/**
 * Repetition: fails when one line is said `min_repeats` times or more. The judge then confirms it wasn't legitimate
 * (re-asking after an unclear reply, repeating on request). N/A when the agent never spoke.
 */
export function repetition(record: CallRecord, params: RepetitionParams): Signal<RepetitionValue> {
  const groups = similarAgentTurns(record.transcript, params);
  const max_repeats = Math.max(0, ...groups.map((g) => g.turns.length));
  const repeated = groups.filter((g) => g.turns.length >= params.min_repeats);
  return {
    result: agentTurns(record).length === 0 ? "na" : repeated.length ? "fail" : "pass",
    value: { groups, max_repeats },
    evidence: repeated.map((g) => turnsEvidence(g.turns)),
  };
}

/** How often each entry of `list` occurs in `tokens`, matched as whole-word sequences (works for any script). */
function countPhrases(tokens: string[], list: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of list) {
    const phrase = words(entry);
    if (phrase.length === 0) continue;
    let n = 0;
    for (let i = 0; i + phrase.length <= tokens.length; i++) {
      if (phrase.every((w, j) => tokens[i + j] === w)) n++;
    }
    if (n > 0) counts[entry] = n;
  }
  return counts;
}

export type StallingFillerValue = {
  agent_words: number;
  stalling: { count: number; by_phrase: Record<string, number> };
  filler: { count: number; by_word: Record<string, number> };
  /** (stalling + filler) per 100 agent words, one decimal. */
  rate: number;
  band: "full" | "partial" | "zero";
};

/**
 * Stalling & filler words (one metric, PRD §4.3): stalling phrases and filler words counted together per 100 agent
 * words, so no timing is needed. Fails above the `partial` band; N/A under `min_agent_words`. Evidence: the agent
 * turns with a hit.
 */
export function stallingFiller(record: CallRecord, params: StallingFillerParams): Signal<StallingFillerValue> {
  const hitTurns: number[] = [];
  const by_phrase: Record<string, number> = {};
  const by_word: Record<string, number> = {};
  let agent_words = 0;
  for (const t of agentTurns(record)) {
    const tokens = words(t.text);
    agent_words += tokens.length;
    const stalls = countPhrases(tokens, params.stalling_phrases);
    const fillers = countPhrases(tokens, params.filler_words);
    for (const [k, n] of Object.entries(stalls)) by_phrase[k] = (by_phrase[k] ?? 0) + n;
    for (const [k, n] of Object.entries(fillers)) by_word[k] = (by_word[k] ?? 0) + n;
    if (Object.keys(stalls).length || Object.keys(fillers).length) hitTurns.push(t.turn);
  }
  const sum = (r: Record<string, number>) => Object.values(r).reduce((a, n) => a + n, 0);
  const stalling = { count: sum(by_phrase), by_phrase };
  const filler = { count: sum(by_word), by_word };
  const rate = agent_words === 0 ? 0 : Math.round(((stalling.count + filler.count) / agent_words) * 1000) / 10;
  const band = rate <= params.per_100_words.full ? "full" : rate <= params.per_100_words.partial ? "partial" : "zero";
  return {
    result: agent_words < params.min_agent_words ? "na" : band === "zero" ? "fail" : "pass",
    value: { agent_words, stalling, filler, rate, band },
    evidence: hitTurns.length ? [turnsEvidence(hitTurns)] : [],
  };
}

/** Scripts we can name from Unicode alone; Latin is split into English and romanised Hindi by word list. */
const SCRIPTS: [lang: string, pattern: RegExp][] = [
  ["hi", /\p{Script=Devanagari}/u],
  ["ur", /\p{Script=Arabic}/u],
  ["bn", /\p{Script=Bengali}/u],
  ["pa", /\p{Script=Gurmukhi}/u],
  ["gu", /\p{Script=Gujarati}/u],
  ["ta", /\p{Script=Tamil}/u],
  ["te", /\p{Script=Telugu}/u],
  ["kn", /\p{Script=Kannada}/u],
  ["ml", /\p{Script=Malayalam}/u],
  ["zh", /\p{Script=Han}/u],
  ["latin", /\p{Script=Latin}/u],
];

/**
 * One turn's language: the script most of its letters are in, so English words inside a Devanagari sentence don't
 * flip it. Latin-script turns are `hi` when enough words are romanised Hindi, else `en`. `und` when too short or
 * without letters ("2008").
 */
export function turnLanguage(text: string, params: Pick<LanguageParams, "min_words" | "hindi_ratio" | "romanised_hindi_words">): string {
  const tokens = words(text);
  if (tokens.length < params.min_words) return "und";
  const letters = new Map<string, number>();
  for (const ch of Array.from(text)) {
    if (!/\p{L}|\p{M}/u.test(ch)) continue;
    const script = SCRIPTS.find(([, re]) => re.test(ch))?.[0];
    if (script) letters.set(script, (letters.get(script) ?? 0) + 1);
  }
  const top = [...letters].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!top) return "und";
  if (top !== "latin") return top;
  const hindi = new Set(params.romanised_hindi_words.map((w) => w.toLowerCase()));
  const share = tokens.filter((w) => hindi.has(w)).length / tokens.length;
  return share >= params.hindi_ratio ? "hi" : "en";
}

export type LanguageValue = {
  turns: { turn: number; speaker: string; lang: string }[];
  /** The caller's language at the end of the call; null when never identified. */
  caller_language: string | null;
  /** Agent turns not in the caller's language. */
  mismatches: number[];
};

/**
 * Language ID per turn, and the `WRONG_LANGUAGE` rule input (PRD §4.3 Language match): fails when
 * `mismatch_turns` agent turns in a row are not in the caller's language. The caller's language is their first
 * identified one, and changes only after `switch_turns` caller turns in a row in another language, so one borrowed
 * line doesn't count as a switch. `und` turns are skipped. N/A when the caller's language is never identified.
 */
export function languageMatch(record: CallRecord, params: LanguageParams): Signal<LanguageValue> {
  const turns = record.transcript.map((t) => ({ turn: t.turn, speaker: t.speaker, lang: turnLanguage(t.text, params) }));
  let caller: string | null = null;
  /** The caller turns that set `caller` (their first identified turn, or the turns of their switch). */
  let callerTurns: number[] = [];
  /** Caller turns in a row in a language other than `caller`; a switch once there are `switch_turns` of them. */
  let candidate: { lang: string; turns: number[] } | null = null as { lang: string; turns: number[] } | null;
  // agent turns in a row not in the caller's language; caller turns in between don't break it
  let run: number[] = [];
  const mismatches: number[] = [];
  const failing: number[][] = [];

  for (const t of turns) {
    if (t.lang === "und") continue;
    if (t.speaker === "agent") {
      if (caller === null || t.lang === caller) {
        run = [];
        continue;
      }
      mismatches.push(t.turn);
      run.push(t.turn);
      if (run.length === params.mismatch_turns) failing.push([...callerTurns, ...run]);
      else if (run.length > params.mismatch_turns) failing[failing.length - 1].push(t.turn);
      continue;
    }
    if (caller === null) {
      caller = t.lang;
      callerTurns = [t.turn];
    }
    if (t.lang === caller) {
      candidate = null;
      continue;
    }
    candidate = candidate?.lang === t.lang ? { lang: t.lang, turns: [...candidate.turns, t.turn] } : { lang: t.lang, turns: [t.turn] };
    if (candidate.turns.length >= params.switch_turns) {
      caller = candidate.lang;
      callerTurns = candidate.turns;
      candidate = null;
      run = [];
    }
  }

  return {
    result: caller === null ? "na" : failing.length ? "fail" : "pass",
    value: { turns, caller_language: caller, mismatches },
    evidence: failing.map(turnsEvidence),
  };
}

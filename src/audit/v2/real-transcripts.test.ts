import { describe, expect, it } from "bun:test";
import { SIGNAL_PARAMS } from "@/db/migrations/0011-signal-params.data";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toCallRecord } from "./call-record";
import type { SignalResult } from "./signal";
import { LanguageParams, RepetitionParams, StallingFillerParams, languageMatch, repetition, stallingFiller } from "./signals";
import { checkConnected, checkConversationHandled, checkDataSaved } from "./system-checks";

/**
 * The checks and signals on 10 real calls (`bun run record:transcripts`, anonymised), with the seeded params of
 * migration 0011. Each expectation was checked by reading the transcript.
 */
const rep = RepetitionParams.parse(SIGNAL_PARAMS.repetition);
const stall = StallingFillerParams.parse(SIGNAL_PARAMS.stalling_filler);
const lang = LanguageParams.parse(SIGNAL_PARAMS.language_match);
const load = (id: number) => toCallRecord(JSON.parse(readFileSync(join(import.meta.dir, `../../../fixtures/transcripts/call-${id}.json`), "utf8")));

type Expected = {
  why: string;
  s1: SignalResult;
  s2: SignalResult;
  ended_by: string;
  loops: number[][];
  s4: SignalResult;
  repetition: SignalResult;
  stalling: SignalResult;
  language: SignalResult;
  caller_language: string | null;
};
const ok: Omit<Expected, "why" | "ended_by"> = {
  s1: "pass",
  s2: "pass",
  loops: [],
  s4: "na",
  repetition: "pass",
  stalling: "pass",
  language: "pass",
  caller_language: "en",
};

const CASES: Record<number, Expected> = {
  2587: { ...ok, why: "Hansa scheduling call, no picked_at on the row; 'let me check' once", ended_by: "agent" },
  3547: { ...ok, why: "Caller, tool payload saved under finishConversation; no data column, so nothing required", ended_by: "agent" },
  3845: { ...ok, why: "Project manager; the caller had the last word and hung up", ended_by: "caller" },
  3906: {
    ...ok,
    why: "'Let me note that down' between different questions: repetition for the judge to confirm, not an S2 loop",
    ended_by: "caller",
    repetition: "fail",
  },
  3978: { ...ok, why: "Project manager; ended on timeout after silence", ended_by: "timeout" },
  4031: {
    ...ok,
    why: "Ended on system_error; the agent said only 'Goodbye!'; the caller spoke Hindi first",
    s2: "fail",
    ended_by: "error",
    stalling: "na",
    caller_language: "hi",
  },
  4038: { ...ok, why: "Project manager; the caller said okay and hung up after the agent's goodbye", ended_by: "caller" },
  4243: {
    ...ok,
    why: "Hansa: re-read 'eight lakh' and 'two thousand' after clear corrections; all required outputs saved",
    s2: "fail",
    ended_by: "caller",
    loops: [
      [27, 29, 31],
      [49, 51, 53, 55, 57, 59],
    ],
    s4: "pass",
    repetition: "fail",
  },
  4431: { ...ok, why: "Caller; three single Hindi lines from an English-speaking caller are not a switch", ended_by: "agent" },
  4572: { ...ok, why: "Caller; demo booked; Caller's save tool requires no saved field", ended_by: "agent" },
};

describe("real transcripts (fixtures/transcripts)", () => {
  for (const [id, e] of Object.entries(CASES)) {
    it(`call ${id}: ${e.why}`, () => {
      const record = load(Number(id));
      const s2 = checkConversationHandled(record, rep);
      const language = languageMatch(record, lang);
      expect({
        s1: checkConnected(record).result,
        s2: s2.result,
        ended_by: s2.value.ended_by.value.ended_by,
        loops: s2.value.loop.value.loops.map((g) => g.turns),
        s4: checkDataSaved(record, []).result,
        repetition: repetition(record, rep).result,
        stalling: stallingFiller(record, stall).result,
        language: language.result,
        caller_language: language.value.caller_language,
      }).toEqual({ ...e, why: undefined } as never);
    });
  }
});

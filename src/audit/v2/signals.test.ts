import { describe, expect, it } from "bun:test";
import fixture4570 from "../../../fixtures/transcripts/call-4570.json";
import { SIGNAL_PARAMS } from "@/db/migrations/0011-signal-params.data";
import { type CallRecord, toCallRecord } from "./call-record";
import {
  LanguageParams,
  RepetitionParams,
  StallingFillerParams,
  languageMatch,
  lineSimilarity,
  normalizeText,
  repetition,
  similarAgentTurns,
  stallingFiller,
  turnLanguage,
} from "./signals";

const rep = RepetitionParams.parse(SIGNAL_PARAMS.repetition);
const stall = StallingFillerParams.parse(SIGNAL_PARAMS.stalling_filler);
const lang = LanguageParams.parse(SIGNAL_PARAMS.language_match);
const call = (turns: [speaker: "agent" | "user", text: string][]): CallRecord => ({
  transcript: turns.map(([speaker, text], i) => ({ turn: i + 1, speaker, text })),
  status: "completed",
  picked_at: null,
  ended_reason: "hangup",
  outcome: null,
  save_tools: [],
});
const call4570 = toCallRecord(fixture4570);
/** `n` filler-free agent words. */
const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

describe("similarity", () => {
  it("keeps Devanagari vowel signs, which v1's normalizeLine drops", () => {
    expect(normalizeText("मेरा नाम, आशा है!")).toBe("मेरा नाम आशा है");
  });

  it("scores near-identical lines high and different questions lower", () => {
    expect(lineSimilarity("Is that right?", "is that right")).toBe(1);
    // call 4243: the same confirmation, worded two ways
    expect(lineSimilarity("So your current CTC is eight lakh — is that right?", "So your current CTC is eight lakh — is that correct?")).toBeGreaterThan(0.85);
    expect(lineSimilarity("What is your notice period?", "How many years of experience do you have?")).toBeLessThan(0.5);
    expect(lineSimilarity("आपका नोटिस पीरियड कितना है?", "आपका नोटिस पीरियड कितना है")).toBe(1);
  });

  it("groups lines linked through a variant, in turn order", () => {
    const right = "So your monthly salary is two thousand, is that right?";
    const correct = "So your monthly salary is two thousand, is that correct?";
    const groups = similarAgentTurns(call([["agent", right], ["agent", correct], ["agent", "Okay"], ["agent", right]]).transcript, rep);
    expect(groups.map((g) => g.turns)).toEqual([[1, 2, 4]]);
  });
});

describe("repetition (PRD §4.3)", () => {
  it("fails when one line is said min_repeats times, citing every repeat", () => {
    const line = "We basically run your sales and marketing on autopilot.";
    const r = repetition(call([["agent", line], ["user", "ok"], ["agent", line], ["user", "ok"], ["agent", line]]), rep);
    expect(r.result).toBe("fail");
    expect(r.value.max_repeats).toBe(3);
    expect(r.evidence).toEqual([{ turns: [1, 3, 5], ts_start: null, ts_end: null }]);
  });

  it("ignores short lines and passes below min_repeats; N/A when the agent never spoke", () => {
    expect(repetition(call([["agent", "Okay"], ["agent", "Okay"], ["agent", "Okay"]]), rep).result).toBe("pass");
    expect(repetition(call([["user", "Hello"]]), rep).result).toBe("na");
  });

  it("counts mixed Hindi/English lines the same way", () => {
    const line = "Aapka notice period kitna hai? Please bataiye.";
    expect(repetition(call([["agent", line], ["agent", line], ["agent", line]]), rep).result).toBe("fail");
  });
});

describe("stalling & filler words (PRD §4.3)", () => {
  it("counts stalling phrases and fillers per 100 agent words, with bands from params", () => {
    // 100 agent words with 2 hits: 2 per 100, between full (1) and partial (3)
    const r = stallingFiller(call([["agent", `Let me check. ${words(96)}`], ["agent", "Basically"]]), stall);
    expect(r.value).toEqual({
      agent_words: 100,
      stalling: { count: 1, by_phrase: { "let me check": 1 } },
      filler: { count: 1, by_word: { basically: 1 } },
      rate: 2,
      band: "partial",
    });
    expect(r.result).toBe("pass");
    expect(r.evidence).toEqual([{ turns: [1, 2], ts_start: null, ts_end: null }]);
    expect(stallingFiller(call([["agent", `umm ${words(99)}`]]), stall).value.band).toBe("full");
  });

  it("fails above the partial band", () => {
    const r = stallingFiller(call([["agent", `umm actually ek minute matlab ${words(21)}`]]), stall);
    expect(r.value.rate).toBeGreaterThan(3);
    expect(r).toMatchObject({ result: "fail", value: { band: "zero", filler: { by_word: { umm: 1, actually: 1, matlab: 1 } } } });
  });

  it("matches whole words only, and ignores the caller", () => {
    const r = stallingFiller(call([["agent", `Factually, humming and uhh are not fillers. ${words(20)}`], ["user", "umm umm umm"]]), stall);
    expect(r.value.filler.count).toBe(0);
  });

  it("is N/A under min_agent_words", () => {
    expect(stallingFiller(call([["agent", "umm okay"]]), stall).result).toBe("na");
    expect(stallingFiller(call([["agent", "umm okay"]]), { ...stall, min_agent_words: 1 }).result).toBe("fail");
  });
});

describe("language per turn (PRD §4.3 Language match)", () => {
  it("identifies script, romanised Hindi, and too-short turns", () => {
    expect(turnLanguage("मुझे कल कॉल कीजिए", lang)).toBe("hi");
    expect(turnLanguage("Haan ji, mujhe kal call kar dijiye", lang)).toBe("hi");
    expect(turnLanguage("Main abhi busy hoon, baad mein baat karte hain", lang)).toBe("hi");
    expect(turnLanguage("Yes please send me the details", lang)).toBe("en");
    expect(turnLanguage("ਅੱਛਾ ਅੱਛਾ।", lang)).toBe("pa");
    expect(turnLanguage("Haan", lang)).toBe("und");
    expect(turnLanguage("2008 2009", lang)).toBe("und");
  });

  it("borrowed English words don't flip a Hindi turn", () => {
    expect(turnLanguage("मेरा laptop खराब है", lang)).toBe("hi");
    expect(turnLanguage("Mera laptop kharab hai", lang)).toBe("hi");
    expect(turnLanguage("My main account is fine", lang)).toBe("en");
  });

  it("fails when the agent keeps replying in English after the caller switched to Hindi", () => {
    const r = languageMatch(
      call([
        ["agent", "Are you interested in a demo?"],
        ["user", "Yes I am interested"],
        ["agent", "Great, when are you free?"],
        ["user", "Kya aap Hindi mein baat kar sakte hain?"],
        ["agent", "Sure, tomorrow at ten works?"],
        ["user", "मुझे हिंदी में बताइए"],
        ["agent", "I will send the details on WhatsApp."],
        ["agent", "Is there anything else I can help with?"],
      ]),
      lang,
    );
    expect(r.result).toBe("fail");
    expect(r.value.caller_language).toBe("hi");
    expect(r.value.mismatches).toEqual([7, 8]);
    // the caller turns of the switch, then the agent turns that ignored it
    expect(r.evidence).toEqual([{ turns: [4, 6, 7, 8], ts_start: null, ts_end: null }]);
  });

  it("one Hindi line from an English-speaking caller isn't a switch", () => {
    const r = languageMatch(
      call([
        ["agent", "What does your business do?"],
        ["user", "We sell clothes online"],
        ["user", "तो मतलब आप टेक्नोलॉजी कंपनी हैं?"],
        ["agent", "We provide both the platform and services."],
        ["agent", "What else is on your mind?"],
      ]),
      lang,
    );
    expect(r.result).toBe("pass");
    expect(r.value.caller_language).toBe("en");
  });

  it("passes when the agent follows the switch, and is N/A when the caller's language is never known", () => {
    const followed = call([
      ["user", "Can we talk in Hindi please?"],
      ["user", "Haan, mujhe Hindi mein bataiye"],
      ["user", "Aap kaun bol rahe hain?"],
      ["agent", "Ji, main aapko abhi Hindi mein batata hoon"],
    ]);
    expect(languageMatch(followed, lang).result).toBe("pass");
    expect(languageMatch(call([["agent", "Hello there"], ["user", "Hello"]]), lang).result).toBe("na");
  });
});

describe("call 4570 (docs/v2-gap-analysis.md example)", () => {
  it("no repetition, fillers within the full band, English throughout", () => {
    expect(repetition(call4570, rep).result).toBe("pass");
    expect(stallingFiller(call4570, stall)).toMatchObject({ result: "pass", value: { band: "full", filler: { by_word: { basically: 1 } } } });
    const l = languageMatch(call4570, lang);
    expect(l.result).toBe("pass");
    expect(new Set(l.value.turns.map((t) => t.lang))).toEqual(new Set(["en", "und"]));
  });
});

describe("branches not covered above", () => {
  it("param schemas reject missing or out-of-range thresholds", () => {
    expect(RepetitionParams.safeParse({ ...SIGNAL_PARAMS.repetition, min_repeats: 1 }).success).toBe(false);
    expect(StallingFillerParams.safeParse({ ...SIGNAL_PARAMS.stalling_filler, per_100_words: undefined }).success).toBe(false);
    expect(LanguageParams.safeParse({ ...SIGNAL_PARAMS.language_match, hindi_ratio: 2 }).success).toBe(false);
  });

  it("a group's similarity is its weakest link", () => {
    const a = "So your monthly salary is two thousand, is that right?";
    const b = "So your monthly salary is two thousand, is that correct?";
    const [g] = similarAgentTurns(call([["agent", a], ["agent", b]]).transcript, rep);
    expect(g!.similarity).toBe(Math.round(lineSimilarity(a, b) * 100) / 100);
    expect(g!.similarity).toBeLessThan(1);
  });

  it("stalling: no agent words is N/A with rate 0", () => {
    expect(stallingFiller(call([["user", "umm"]]), stall)).toMatchObject({ result: "na", value: { agent_words: 0, rate: 0 } });
  });

  it("names the other Indian scripts and Han", () => {
    const cases: [string, string][] = [
      ["آپ کیسے ہیں", "ur"],
      ["আপনি কেমন আছেন", "bn"],
      ["તમે કેમ છો", "gu"],
      ["நீங்கள் எப்படி இருக்கிறீர்கள்", "ta"],
      ["మీరు ఎలా ఉన్నారు", "te"],
      ["ನೀವು ಹೇಗಿದ್ದೀರಿ ಸರ್", "kn"],
      ["സുഖമാണോ നിങ്ങൾക്ക്", "ml"],
      ["那我 再找個", "zh"],
    ];
    for (const [text, code] of cases) expect([text, turnLanguage(text, lang)]).toEqual([text, code]);
  });

  it("a mismatch run keeps growing past mismatch_turns, across caller turns; agent `und` turns are skipped", () => {
    const r = languageMatch(
      call([
        ["user", "मुझे हिंदी में बताइए"],
        ["agent", "Sure, I can help you with that"],
        ["agent", "Okay"],
        ["user", "हिंदी में बोलिए ना"],
        ["agent", "The demo is on Friday at ten"],
        ["agent", "Is there anything else today"],
      ]),
      lang,
    );
    expect(r.value.mismatches).toEqual([2, 5, 6]);
    expect(r.evidence).toEqual([{ turns: [1, 2, 5, 6], ts_start: null, ts_end: null }]);
  });

  it("a caller back in their language cancels a half-made switch", () => {
    const r = languageMatch(
      call([
        ["user", "Yes I am free now"],
        ["user", "मुझे बताइए"],
        ["user", "Okay tell me more"],
        ["user", "अच्छा ठीक है"],
        ["agent", "We help with sales and marketing"],
        ["agent", "Would you like a demo"],
      ]),
      lang,
    );
    expect(r).toMatchObject({ result: "pass", value: { caller_language: "en" } });
  });

  it("an agent that switches back to the caller's language ends the run", () => {
    const r = languageMatch(
      call([
        ["user", "Kya aap Hindi mein baat kar sakte hain"],
        ["agent", "Sure, what would you like to know"],
        ["agent", "Ji, main aapko abhi batata hoon"],
        ["agent", "Let me know your free time"],
      ]),
      lang,
    );
    expect(r).toMatchObject({ result: "pass", value: { mismatches: [2, 4] } });
  });
});

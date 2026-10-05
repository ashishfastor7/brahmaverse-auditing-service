import { describe, expect, it } from "bun:test";
import { auditCall, type Judge } from "./audit-call";
import { locateQuote, validateEvidence } from "./evidence";
import { normalizeCall } from "./normalize";
import { ruleFailures, skipReason } from "./rules";
import { rubricFor } from "./rubrics";
import { hansaRubric } from "./rubrics/hansa";
import { auditorConfidence, overallScore, qualityScore } from "./score";

const transcript = [
  { speaker: "agent", text: "Hi, this is Hansa from Acme Tech. Is this a good time?" },
  { speaker: "user", text: "Yes, go ahead." },
  { speaker: "agent", text: "What is your notice period?" },
  { speaker: "user", text: "Thirty days." },
  { speaker: "agent", text: "Thirty days, noted. Our team will email you next steps." },
];

const call = (overrides: Record<string, unknown> = {}) =>
  normalizeCall({
    id: 7,
    business_id: 10,
    agent_id: 3,
    agent_code: "hrms",
    status: "completed",
    ended_reason: "hangup",
    transcriptions: transcript,
    ...overrides,
  });

describe("normalizeCall", () => {
  it("numbers turns from 1 and drops empty lines", () => {
    const input = call({ transcriptions: [{ speaker: "agent", text: "Hi" }, { speaker: "user", text: "  " }, { speaker: "USER", text: "Hello" }] });
    expect(input.transcript).toEqual([
      { turn: 1, speaker: "agent", text: "Hi" },
      { turn: 2, speaker: "user", text: "Hello" },
    ]);
  });

  it("reads agent_code, prompt_code and variables from a raw DB row's data column (stringified JSON)", () => {
    const input = normalizeCall({
      id: 1,
      business_id: 2,
      status: "completed",
      transcriptions: JSON.stringify(transcript),
      data: JSON.stringify({ agent_code: "hrms", config: { prompt_code: "screen", variables: { ctc_range: "6-8 LPA" }, is_playground: true } }),
    });
    expect(input.agent_code).toBe("hrms");
    expect(input.prompt_code).toBe("screen");
    expect(input.variables).toEqual({ ctc_range: "6-8 LPA" });
    expect(input.is_playground).toBe(true);
    expect(input.transcript).toHaveLength(5);
  });

  it("lets overrides fill what a listing row lacks", () => {
    expect(normalizeCall({ id: 1, business_id: 2, status: "completed" }, { agent_code: "hrms" }).agent_code).toBe("hrms");
  });
});

describe("rubricFor", () => {
  it("maps hrms to Hansa and anything else to the default rubric", () => {
    expect(rubricFor("hrms").version).toBe("hansa-v1");
    expect(rubricFor("HRMS").version).toBe("hansa-v1");
    expect(rubricFor("varuna").version).toBe("default-v1");
    expect(rubricFor(null).version).toBe("default-v1");
  });
});

describe("skipReason", () => {
  it("skips unfinished, playground and empty calls", () => {
    expect(skipReason(call({ status: "no_answer" }), { includePlayground: false })).toBe("NOT_COMPLETED");
    expect(skipReason(call({ is_playground: true }), { includePlayground: false })).toBe("PLAYGROUND");
    expect(skipReason(call({ is_playground: true }), { includePlayground: true })).toBeNull();
    expect(skipReason(call({ transcriptions: [] }), { includePlayground: false })).toBe("NO_TRANSCRIPT");
    expect(skipReason(call(), { includePlayground: false })).toBeNull();
  });
});

describe("ruleFailures", () => {
  it("passes a normal call", () => {
    expect(ruleFailures(call(), hansaRubric)).toEqual([]);
  });

  it("fails technical errors", () => {
    expect(ruleFailures(call({ ended_reason: "system_error" }), hansaRubric).map((f) => f.code)).toEqual(["CALL_ERROR"]);
  });

  it("fails a call where the agent never spoke", () => {
    const codes = ruleFailures(call({ transcriptions: [{ speaker: "user", text: "Hello? Hello?" }] }), hansaRubric).map((f) => f.code);
    expect(codes).toContain("NO_AGENT_SPEECH");
  });

  it("detects a loop of the same agent line, ignoring case and punctuation", () => {
    const line = { speaker: "agent", text: "What is your notice period?" };
    const looped = [line, { speaker: "user", text: "30" }, { ...line, text: "what is your NOTICE period" }, { speaker: "user", text: "30!" }, line];
    const failures = ruleFailures(call({ transcriptions: looped }), hansaRubric);
    expect(failures.map((f) => f.code)).toEqual(["AGENT_LOOP"]);
    expect(failures[0].turn).toBe(1);
  });

  it("does not count short acknowledgements as a loop", () => {
    const acks = Array.from({ length: 4 }, () => [{ speaker: "agent", text: "Okay." }, { speaker: "user", text: "Yes" }]).flat();
    expect(ruleFailures(call({ transcriptions: acks }), hansaRubric)).toEqual([]);
  });
});

describe("evidence", () => {
  const turns = call().transcript;

  it("accepts an exact quote ignoring case and punctuation", () => {
    expect(locateQuote(turns, 3, "what is your NOTICE period")).toEqual({ turn: 3, valid: true });
  });

  it("corrects a wrong turn number when the quote exists elsewhere", () => {
    expect(locateQuote(turns, 1, "Thirty days, noted")).toEqual({ turn: 5, valid: true });
  });

  it("accepts a quote shortened with an ellipsis", () => {
    expect(locateQuote(turns, 1, "Hi, this is Hansa ... good time")).toEqual({ turn: 1, valid: true });
  });

  it("accepts a quote that skips a sentence of the turn, but not reworded text", () => {
    const long = [{ turn: 1, speaker: "agent", text: "No problem, sorry to disturb you. I'll try again later. Have a good day!" }];
    expect(locateQuote(long, 1, "No problem, sorry to disturb you. Have a good day!").valid).toBe(true);
    expect(locateQuote(long, 1, "No problem, sorry for the trouble. Have a good day!").valid).toBe(false);
  });

  it("rejects an invented quote", () => {
    expect(locateQuote(turns, 3, "Are you married?").valid).toBe(false);
  });

  it("reports the valid share and marks each item", () => {
    const items: { turn: number; quote: string; valid?: boolean }[] = [
      { turn: 3, quote: "notice period" },
      { turn: 2, quote: "something nobody said" },
    ];
    expect(validateEvidence(turns, items)).toBe(0.5);
    expect(items.map((i) => i.valid)).toEqual([true, false]);
  });
});

describe("scores", () => {
  const all = (score: number) =>
    Object.fromEntries(hansaRubric.dimensions.map((d) => [d.key, { applicable: true, score, reasoning: "", evidence: [] }]));

  it("maps 0–4 dimension scores to 0–100 by weight", () => {
    expect(qualityScore(hansaRubric, all(4))).toBe(100);
    expect(qualityScore(hansaRubric, all(2))).toBe(50);
    expect(qualityScore(hansaRubric, { ...all(4), question_coverage: { applicable: true, score: 0, reasoning: "", evidence: [] } })).toBe(80);
  });

  it("leaves non-applicable dimensions out instead of scoring them 0", () => {
    const na = { applicable: false, score: null, reasoning: "", evidence: [] };
    expect(qualityScore(hansaRubric, { ...all(4), question_coverage: na, answer_confirmation: na })).toBe(100);
    const none = Object.fromEntries(hansaRubric.dimensions.map((d) => [d.key, na]));
    expect(qualityScore(hansaRubric, none)).toBeNull();
    expect(overallScore(hansaRubric, null, false)).toBeNull();
    expect(overallScore(hansaRubric, null, true)).toBe(0);
  });

  it("caps a failed call's overall score", () => {
    expect(overallScore(hansaRubric, 90, false)).toBe(90);
    expect(overallScore(hansaRubric, 90, true)).toBe(40);
    expect(overallScore(hansaRubric, 25, true)).toBe(25);
  });

  it("lowers confidence for invented evidence, a poor transcript and a missing agent prompt", () => {
    const best = auditorConfidence({ selfConfidence: 1, evidenceValidity: 1, transcriptQuality: "good", hadAgentPrompt: true });
    expect(best).toBe(1);
    expect(auditorConfidence({ selfConfidence: 1, evidenceValidity: 0.5, transcriptQuality: "good", hadAgentPrompt: true })).toBeLessThan(best);
    expect(auditorConfidence({ selfConfidence: 1, evidenceValidity: 1, transcriptQuality: "poor", hadAgentPrompt: true })).toBeLessThan(best);
    expect(auditorConfidence({ selfConfidence: 1, evidenceValidity: 1, transcriptQuality: "good", hadAgentPrompt: false })).toBe(0.95);
  });
});

describe("auditCall", () => {
  const judgeOutput = (overrides: Record<string, unknown> = {}) => ({
    transcript_quality: { rating: "good", note: "" },
    failures: [],
    goal: { explanation: "Screening done.", evidence: [{ turn: 4, quote: "Thirty days" }], result: "ACHIEVED", reason_code: "SCREENING_COMPLETED" },
    dimensions: hansaRubric.dimensions.map((d) => ({
      key: d.key,
      applicable: true,
      reasoning: "ok",
      evidence: [{ turn: 3, quote: "notice period" }],
      score: 4,
    })),
    went_well: [{ point: "Confirmed the notice period", turn: 5, quote: "Thirty days, noted" }],
    went_wrong: [],
    sentiment: { start: "neutral", end: "positive", note: "" },
    verdict: "Clean screening.",
    confidence: 0.9,
    ...overrides,
  });
  const stub = (output: unknown): Judge => async () => ({ output, model: "stub", usage: { input_tokens: 1, output_tokens: 1 } });
  const deps = (output: unknown) => ({ judge: stub(output), rubric: hansaRubric, agentPrompt: null, reviewThreshold: 0.7 });

  it("produces the dashboard result shape", async () => {
    const { result } = await auditCall(call(), deps(judgeOutput()));
    expect(result.overall_score).toBe(100);
    expect(result.call_success).toEqual({ result: "PASS", failure_reasons: [] });
    expect(result.call_goal.result).toBe("ACHIEVED");
    expect(result.call_goal.reason_code).toBe("SCREENING_COMPLETED");
    expect(Object.keys(result.metrics)).toEqual(hansaRubric.dimensions.map((d) => d.key));
    expect(result.metrics.active_listening.evidence[0].valid).toBe(true);
    expect(result.went_well[0]).toMatchObject({ turn: 5, valid: true });
    expect(result.sentiment).toMatchObject({ start: "neutral", end: "positive" });
    expect(result.rubric_version).toBe("hansa-v1");
    expect(result.judge.evidence_validity).toBe(1);
  });

  it("fails the call and caps the score on an LLM-reported failure", async () => {
    const output = judgeOutput({
      failures: [{ code: "UNAUTHORIZED_PROMISE", explanation: "Promised an offer.", turn: 5, quote: "Our team will email you" }],
    });
    const { result } = await auditCall(call(), deps(output));
    expect(result.call_success.result).toBe("FAIL");
    expect(result.call_success.failure_reasons[0]).toMatchObject({ code: "UNAUTHORIZED_PROMISE", source: "llm" });
    expect(result.overall_score).toBe(40);
    expect(result.quality_score).toBe(100);
  });

  it("merges rule failures and does not double-report a code both found", async () => {
    const output = judgeOutput({ failures: [{ code: "AGENT_LOOP", explanation: "Looped.", turn: 1, quote: "x" }] });
    const { result } = await auditCall(call({ ended_reason: "connection_error" }), deps(output));
    expect(result.call_success.failure_reasons.map((f) => `${f.source}:${f.code}`)).toEqual(["rule:CALL_ERROR", "llm:AGENT_LOOP"]);
  });

  it("reports each failure code once even if the judge repeats it", async () => {
    const twice = { code: "IGNORED_STOP_REQUEST", explanation: "", turn: 1, quote: "x" };
    const { result } = await auditCall(call(), deps(judgeOutput({ failures: [twice, { ...twice, turn: 3 }] })));
    expect(result.call_success.failure_reasons).toHaveLength(1);
  });

  it("drops failure codes that are not in the rubric", async () => {
    const output = judgeOutput({ failures: [{ code: "MADE_UP", explanation: "", turn: 1, quote: "" }] });
    const { result } = await auditCall(call(), deps(output));
    expect(result.call_success.result).toBe("PASS");
  });

  it("fixes a goal reason code from the wrong bucket", async () => {
    const output = judgeOutput({ goal: { explanation: "", evidence: [], result: "ACHIEVED", reason_code: "CALLBACK_REQUESTED" } });
    const { result } = await auditCall(call(), deps(output));
    expect(result.call_goal.reason_code).toBe("SCREENING_COMPLETED");
  });

  it("flags invented evidence and lowers confidence into review", async () => {
    const output = judgeOutput({
      went_wrong: [
        { point: "Asked about marriage", turn: 3, quote: "Are you married?", severity: "high" },
        { point: "Asked about age", turn: 3, quote: "How old are you?", severity: "high" },
      ],
      dimensions: hansaRubric.dimensions.map((d) => ({ key: d.key, applicable: true, reasoning: "", evidence: [{ turn: 1, quote: "never said" }], score: 3 })),
      confidence: 0.6,
    });
    const { result } = await auditCall(call(), deps(output));
    expect(result.went_wrong.every((w) => w.valid === false)).toBe(true);
    expect(result.judge.evidence_validity).toBeLessThan(0.5);
    expect(result.needs_review).toBe(true);
  });

  it("rejects output that leaves a dimension unscored", async () => {
    const output = judgeOutput({ dimensions: [{ key: "intent_understanding", applicable: true, reasoning: "", evidence: [], score: 4 }] });
    expect(auditCall(call(), deps(output))).rejects.toThrow("did not score dimensions");
  });

  it("nulls the score of a non-applicable dimension whatever the judge put there", async () => {
    const output = judgeOutput({
      dimensions: hansaRubric.dimensions.map((d) => ({
        key: d.key,
        applicable: d.key !== "question_coverage",
        reasoning: "",
        evidence: [],
        score: d.key === "question_coverage" ? 0 : 4,
      })),
    });
    const { result } = await auditCall(call(), deps(output));
    expect(result.metrics.question_coverage).toMatchObject({ applicable: false, score: null });
    expect(result.quality_score).toBe(100);
  });

  it("rejects malformed output", async () => {
    expect(auditCall(call(), deps({ nonsense: true }))).rejects.toThrow();
  });
});

import { describe, expect, it } from "bun:test";
import fixture4570 from "../../../fixtures/transcripts/call-4570.json";
import { SIGNAL_PARAMS } from "@/db/migrations/0011-signal-params.data";
import { type CallRecord, toCallRecord } from "./call-record";
import { RepetitionParams } from "./signals";
import { checkConnected, checkConversationHandled, checkDataSaved, checkEndedBy, checkLoop, checkNoResponse, systemGoal } from "./system-checks";

const params = RepetitionParams.parse(SIGNAL_PARAMS.repetition);
/** A completed call; `turns` alternate as given, numbered from 1. */
const call = (turns: [speaker: "agent" | "user", text: string][], extra: Partial<CallRecord> = {}): CallRecord => ({
  transcript: turns.map(([speaker, text], i) => ({ turn: i + 1, speaker, text })),
  status: "completed",
  picked_at: "2026-10-12T12:10:14.000Z",
  ended_reason: "hangup",
  outcome: null,
  save_tools: [],
  ...extra,
});
/** Call 4570, the anonymised example in docs/v2-gap-analysis.md (recorded with `record:transcripts`). */
const call4570 = toCallRecord(fixture4570);

describe("S1 checkConnected (PRD §3.1)", () => {
  it("passes when picked up and the agent spoke", () => {
    expect(checkConnected(call([["agent", "Hi"], ["user", "Hello"]]))).toEqual({
      result: "pass",
      reason: "Picked up, and the agent spoke.",
      value: { status: "completed", picked_at: "2026-10-12T12:10:14.000Z", agent_turns: 1, caller_turns: 1 },
      evidence: [],
    });
  });

  it("fails when the agent never spoke", () => {
    expect(checkConnected(call([["user", "Hello?"]])).result).toBe("fail");
  });

  it("is N/A for calls that never connected: not completed, or unjoined", () => {
    expect(checkConnected(call([], { status: "no_answer" })).result).toBe("na");
    expect(checkConnected(call([["user", "Hello"]], { ended_reason: "unjoined", picked_at: null })).result).toBe("na");
  });

  it("without picked_at, a caller turn shows the call was picked up", () => {
    expect(checkConnected(call([["agent", "Hi"], ["user", "Yes"]], { picked_at: null })).result).toBe("pass");
    expect(checkConnected(call([["agent", "Hi"]], { picked_at: null })).result).toBe("fail");
  });
});

describe("S2 rule parts (PRD §3.1)", () => {
  it("ended by: an error fails and cites the last turn; caller, agent and timeout endings pass", () => {
    expect(checkEndedBy(call([["agent", "Hi"], ["user", "Hello"]], { ended_reason: "system_error" }))).toEqual({
      result: "fail",
      reason: "The call ended on a technical error (system_error).",
      value: { ended_reason: "system_error", ended_by: "error" },
      evidence: [{ turns: [2], ts_start: null, ts_end: null }],
    });
    for (const [reason, by] of [
      ["hangup", "caller"],
      ["caller_hangup", "caller"],
      ["agent_hangup", "agent"],
      ["bot_hangup", "agent"],
      ["timeout", "timeout"],
      ["completed", "unknown"],
    ]) {
      expect(checkEndedBy(call([["agent", "Hi"]], { ended_reason: reason }))).toMatchObject({ result: "pass", value: { ended_by: by } });
    }
    expect(checkEndedBy(call([["agent", "Hi"]], { ended_reason: null })).result).toBe("na");
  });

  const notice = "So your notice period is thirty days, is that right?";
  it("loop: the same line three times after clear answers fails, citing every turn", () => {
    const looped = call([
      ["agent", notice],
      ["user", "No, it is sixty days."],
      ["agent", notice],
      ["user", "Sixty, not thirty."],
      ["agent", "So your notice period is thirty days, is that correct?"],
    ]);
    expect(checkLoop(looped, params)).toMatchObject({ result: "fail", evidence: [{ turns: [1, 3, 5], ts_start: null, ts_end: null }] });
  });

  it("loop: re-asks after an unclear reply or silence don't count", () => {
    const reasks = call([
      ["agent", notice],
      ["user", "I"],
      ["agent", notice],
      ["agent", notice],
      ["user", "Thirty, yes."],
    ]);
    expect(checkLoop(reasks, params).result).toBe("pass");
  });

  it("loop: a different line in between is progress", () => {
    const ack = "Let me note that down.";
    const steady = call([
      ["agent", "What is your name?"],
      ["user", "Asha"],
      ["agent", ack],
      ["agent", "What is your current role?"],
      ["user", "Engineer"],
      ["agent", ack],
      ["agent", "What is your notice period?"],
      ["user", "Thirty days"],
      ["agent", ack],
    ]);
    expect(checkLoop(steady, params).result).toBe("pass");
  });

  it("loop: thresholds come from params", () => {
    const twice = call([
      ["agent", notice],
      ["user", "No, sixty."],
      ["agent", notice],
    ]);
    expect(checkLoop(twice, params).result).toBe("pass");
    expect(checkLoop(twice, { ...params, min_repeats: 2 }).result).toBe("fail");
  });

  it("no response: a caller question left unanswered when the agent hung up fails", () => {
    const dropped = call(
      [
        ["agent", "Your condition doesn't match. Thank you."],
        ["user", "What condition does not match?"],
      ],
      { ended_reason: "agent_hangup" },
    );
    expect(checkNoResponse(dropped)).toEqual({
      result: "fail",
      reason: "The caller's question (turn 2) got no reply before the call ended.",
      value: { unanswered_turns: [2], asked_question: true, ended_by: "agent" },
      evidence: [{ turns: [2], ts_start: null, ts_end: null }],
    });
  });

  it("no response: a trailing goodbye, or the caller hanging up, passes", () => {
    const bye = call(
      [
        ["agent", "Have a great day."],
        ["user", "Okay, bye."],
      ],
      { ended_reason: "agent_hangup" },
    );
    expect(checkNoResponse(bye).result).toBe("pass");
    const hungUp = call(
      [
        ["agent", "Anything else?"],
        ["user", "Can you send it on WhatsApp?"],
      ],
      { ended_reason: "hangup" },
    );
    expect(checkNoResponse(hungUp).result).toBe("pass");
    expect(checkNoResponse(call([["agent", "Hello?"]])).result).toBe("na");
  });

  it("conversation handled: fails if any part fails, with that part's evidence", () => {
    const errored = call([["agent", "Hi"], ["user", "Hello"]], { ended_reason: "connection_error" });
    const s2 = checkConversationHandled(errored, params);
    expect(s2.result).toBe("fail");
    expect(s2.evidence).toEqual([{ turns: [2], ts_start: null, ts_end: null }]);
    expect(s2.value.loop.result).toBe("pass");
    expect(checkConversationHandled(call([], { ended_reason: null }), params).result).toBe("na");
  });
});

describe("S4 checkDataSaved (PRD §3.1, Open #8)", () => {
  const hansaTool = { name: "submitScreeningCallOutcome", wrapper: "outcome", required: ["currently_working", "notice_period"] };

  it("passes when every required output is in the outcome, ignoring case and punctuation", () => {
    const saved = call([], { save_tools: [hansaTool], outcome: { Currently_Working: true, "notice-period": 30 } });
    expect(checkDataSaved(saved, [])).toEqual({
      result: "pass",
      reason: "All 2 required outputs saved.",
      value: { source: "save_tool", required: ["currently_working", "notice_period"], present: ["currently_working", "notice_period"], missing: [] },
      evidence: [],
    });
  });

  it("fails when a required output is missing, null or empty", () => {
    const partial = call([], { save_tools: [hansaTool], outcome: { currently_working: true, notice_period: "" } });
    expect(checkDataSaved(partial, [])).toMatchObject({ result: "fail", value: { missing: ["notice_period"] } });
  });

  it("reads tool payloads stored under the tool's name (2026-08-20 to 09-08 rows)", () => {
    const tool = { name: "finishConversation", wrapper: "data", required: ["company_name"] };
    const payload = call([], { save_tools: [tool], outcome: { finishConversation: { status: "completed", data: { company_name: "X" } } } });
    expect(checkDataSaved(payload, []).result).toBe("pass");
  });

  it("falls back to the goal config's required outputs on calls without data", () => {
    const old = call([], { outcome: { demo_datetime: "Friday 3 pm" } });
    expect(checkDataSaved(old, ["demo_datetime", "contact_channel"])).toMatchObject({
      result: "fail",
      value: { source: "goal_config", missing: ["contact_channel"] },
    });
  });

  it("is N/A when nothing is required or nothing was saved", () => {
    expect(checkDataSaved(call([], { outcome: { a: 1 } }), []).result).toBe("na");
    expect(checkDataSaved(call([], { save_tools: [hansaTool], outcome: null }), []).result).toBe("na");
    expect(checkDataSaved(call([], { save_tools: [hansaTool], outcome: {} }), []).result).toBe("na");
  });
});

describe("call 4570 (docs/v2-gap-analysis.md example)", () => {
  it("connected, handled, nothing for S4 to check", () => {
    expect(checkConnected(call4570).result).toBe("pass");
    const s2 = checkConversationHandled(call4570, params);
    expect(s2.result).toBe("pass");
    expect(s2.value.ended_by.value.ended_by).toBe("caller");
    // the re-asks after the split "I" / "Manually" replies are recovery, not a loop
    expect(s2.value.loop.value.loops).toEqual([]);
    expect(s2.value.no_response.value.unanswered_turns).toEqual([]);
    // Caller's finishConversation requires only `status`; the saved `data` fields are all optional
    expect(call4570.save_tools).toContainEqual({ name: "finishConversation", wrapper: "data", required: [] });
    expect(checkDataSaved(call4570, []).result).toBe("na");
  });
});

describe("branches not covered above", () => {
  it("S1 fails with no pick-up time and no caller turn, and says why", () => {
    expect(checkConnected(call([["agent", "Hi"]], { picked_at: null })).reason).toBe("No pick-up time and the caller never spoke.");
    expect(checkConnected(call([], { status: "no_answer" })).reason).toBe("Not connected (no_answer).");
  });

  it("ended by: an error with an empty transcript cites nothing", () => {
    expect(checkEndedBy(call([], { ended_reason: "connection_error" }))).toMatchObject({ result: "fail", evidence: [] });
  });

  it("loop: a reply split over caller turns counts as one reply of all its words", () => {
    const line = "How do you handle new leads and follow-ups?";
    const split = call([
      ["agent", line],
      ["user", "Mostly"],
      ["user", "manually"],
      ["agent", line],
      ["user", "By phone"],
      ["agent", line],
    ]);
    // "Mostly" + "manually" is 2 words, over unclear_reply_max_words (1), so every repeat counts
    expect(checkLoop(split, params).value.loops.map((g) => g.turns)).toEqual([[1, 4, 6]]);
  });

  it("no response: a caller question cut off by a technical error fails", () => {
    const cut = call(
      [
        ["agent", "Shall I book it?"],
        ["user", "Which day?"],
      ],
      { ended_reason: "system_error" },
    );
    expect(checkNoResponse(cut)).toMatchObject({ result: "fail", value: { ended_by: "error" } });
  });

  it("conversation handled: the failing parts' reasons are joined", () => {
    const both = call(
      [
        ["agent", "Hi"],
        ["user", "Why?"],
      ],
      { ended_reason: "connection_error" },
    );
    expect(checkConversationHandled(both, params).reason).toBe(
      "The call ended on a technical error (connection_error). The caller's question (turn 2) got no reply before the call ended.",
    );
  });

  it("S4: two save tools are both checked; a payload without its wrapper is read as is; non-ASCII keys match", () => {
    const a = { name: "saveA", wrapper: "data", required: ["x"] };
    const b = { name: "saveB", wrapper: null, required: ["कुल"] };
    const r = checkDataSaved(call([], { save_tools: [a, b], outcome: { saveA: { x: 1 }, "कुल ": 2 } }), []);
    expect(r).toMatchObject({ result: "pass", value: { required: ["x", "कुल"], present: ["x", "कुल"] } });
    expect(checkDataSaved(call([], { save_tools: [a], outcome: { x: null } }), []).value.missing).toEqual(["x"]);
  });

  it("S4: a goal config fallback that is all present passes", () => {
    expect(checkDataSaved(call([], { outcome: { demo_datetime: "Fri" } }), ["demo_datetime"])).toMatchObject({
      result: "pass",
      value: { source: "goal_config" },
    });
  });
});

describe("systemGoal (PRD §3.1)", () => {
  const r = (result: "pass" | "fail" | "na") => ({ result });
  it("passes when every applicable check passes; N/A checks are left out", () => {
    expect(systemGoal({ S1: r("pass"), S2: r("pass"), S3: r("na"), S4: r("na") })).toEqual({ result: "pass", failed: [] });
  });
  it("fails on any failed check and lists them", () => {
    expect(systemGoal({ S1: r("pass"), S2: r("fail"), S3: r("na"), S4: r("fail") })).toEqual({ result: "fail", failed: ["S2", "S4"] });
  });
  it("is N/A when every check is N/A", () => {
    expect(systemGoal({ S1: r("na"), S2: r("na"), S3: r("na"), S4: r("na") })).toEqual({ result: "na", failed: [] });
  });
});

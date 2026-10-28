import { describe, expect, it } from "bun:test";
import { toCallRecord } from "./call-record";

const row = (extra: Record<string, unknown> = {}) => ({ id: 1, business_id: 7, status: "completed", transcriptions: [], ...extra });
const tools = (...items: unknown[]) => ({ data: { tools: { items } } });

describe("toCallRecord", () => {
  it("reads the save tool's required list from its one object property (Caller `data`, Hansa `outcome`)", () => {
    const hansa = {
      name: "submitScreeningCallOutcome",
      schema: { properties: { outcome: { type: "object", properties: { notice_period: {} }, required: ["notice_period"] } }, required: ["outcome"] },
    };
    const caller = {
      name: "finishConversation",
      schema: { properties: { status: { type: "string" }, data: { type: "object", properties: { name_confirmed: {} } } }, required: ["status"] },
    };
    expect(toCallRecord(row(tools(hansa, caller))).save_tools).toEqual([
      { name: "submitScreeningCallOutcome", wrapper: "outcome", required: ["notice_period"] },
      { name: "finishConversation", wrapper: "data", required: [] },
    ]);
  });

  it("uses the schema's own required list without exactly one object property; skips tools without a schema", () => {
    const flat = { name: "save", schema: { properties: { a: { type: "string" }, b: { type: "number" } }, required: ["a", 3, "b"] } };
    const two = {
      name: "two",
      schema: { properties: { x: { type: "object", properties: {} }, y: { type: "object", properties: {} } }, required: ["x"] },
    };
    const pm = { name: "submitFollowupOutcome", schema: { properties: { task_updates: { type: "array" } } } };
    expect(toCallRecord(row(tools(flat, two, pm, { name: "evaluateExpression", context: {} }, null))).save_tools).toEqual([
      { name: "save", wrapper: null, required: ["a", "b"] },
      { name: "two", wrapper: null, required: ["x"] },
      { name: "submitFollowupOutcome", wrapper: null, required: [] },
    ]);
  });

  it("reads picked_at as ISO, and null when missing or not a date", () => {
    expect(toCallRecord(row({ picked_at: new Date("2026-10-12T12:10:14Z") })).picked_at).toBe("2026-10-12T12:10:14.000Z");
    expect(toCallRecord(row({ picked_at: "2026-10-12T12:10:14Z" })).picked_at).toBe("2026-10-12T12:10:14.000Z");
    expect(toCallRecord(row({ picked_at: {} })).picked_at).toBeNull();
    expect(toCallRecord(row()).picked_at).toBeNull();
  });

  it("keeps only object outcomes, parses JSON strings, and numbers turns like normalizeCall", () => {
    expect(toCallRecord(row({ outcome: "[1, 2]" })).outcome).toBeNull();
    expect(toCallRecord(row({ outcome: '{"a": 1}' })).outcome).toEqual({ a: 1 });
    const r = toCallRecord(
      row({ transcriptions: JSON.stringify([{ speaker: "user", text: "(New Call) Respond as if" }, { speaker: "agent", text: " Hi " }]) }),
    );
    expect(r.transcript).toEqual([{ turn: 1, speaker: "agent", text: "Hi" }]);
    expect(r.save_tools).toEqual([]);
  });
});

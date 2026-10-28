import { describe, expect, it } from "bun:test";
import sample from "../../../fixtures/call-sample.json";
import { callRefs, type CallTools } from "./call-refs";
import { aiFixtureDb, sampleRow, throwingDb } from "./fake-db";
import { MAX_AGENT_PROMPT_CHARS } from "@/audit/judge/prompt";
import { kbScope, readKnowledgeBase, truncateDocs, type KbDocument } from "./knowledge-base";

const kb = { name: "search_knowledgebase", context: {} };

describe("kbScope", () => {
  it("reads document_ids from call 4570's tools", () => {
    expect(kbScope(sample.tools)).toEqual({ kind: "ids", ids: [1070] });
  });

  it("uses document_group when there are no ids, and lets tools.context win over the item's context", () => {
    expect(kbScope({ items: [{ ...kb, context: { document_group: "caller" } }] })).toEqual({ kind: "group", groups: ["caller"] });
    expect(kbScope({ items: [{ ...kb, context: { document_group: "a" } }], context: { document_group: ["b", "c"] } })).toEqual({
      kind: "group",
      groups: ["b", "c"],
    });
    expect(kbScope({ items: [{ ...kb, context: { document_ids: 5 } }], context: { document_group: "caller" } })).toEqual({
      kind: "ids",
      ids: [5],
    });
  });

  it("is everything for calls that stored no tools, or a KB tool with no scope", () => {
    expect(kbScope(null)).toEqual({ kind: "all" });
    expect(kbScope({ items: [kb] })).toEqual({ kind: "all" });
  });

  it("is none when the agent had tools but no search_knowledgebase", () => {
    const tools: CallTools = { items: sample.tools.items.filter((i) => i.name !== "search_knowledgebase"), context: sample.tools.context };
    expect(kbScope(tools)).toEqual({ kind: "none" });
  });

  it("drops ids that aren't integers, and empty groups", () => {
    expect(kbScope({ items: [{ ...kb, context: { document_ids: [1070, "1071", "x", 1.5, null] } }] })).toEqual({
      kind: "ids",
      ids: [1070, 1071],
    });
    expect(kbScope({ items: [{ ...kb, context: { document_group: ["", "caller"] } }] })).toEqual({ kind: "group", groups: ["caller"] });
    expect(kbScope({ items: [{ ...kb, context: { document_group: "" } }] })).toEqual({ kind: "all" });
  });
});

describe("truncateDocs", () => {
  const doc = (id: number, content: string | null): KbDocument => ({
    id,
    document_id: `d${id}`,
    title: null,
    document_group: null,
    agent_code: "caller",
    content,
  });

  it("keeps documents that fit", () => {
    expect(truncateDocs([doc(1, "abc"), doc(2, "de")], 5)).toEqual({
      documents: [doc(1, "abc"), doc(2, "de")],
      truncated: false,
      dropped: 0,
    });
  });

  it("cuts the document that crosses the budget and drops the rest", () => {
    expect(truncateDocs([doc(1, "abc"), doc(2, "defg"), doc(3, "h")], 5)).toEqual({
      documents: [doc(1, "abc"), doc(2, "de\n[...truncated]")],
      truncated: true,
      dropped: 1,
    });
  });

  it("treats a document with no content as empty text, and nothing in as nothing out", () => {
    expect(truncateDocs([doc(1, null), doc(2, "ab")], 5)).toEqual({ documents: [doc(1, ""), doc(2, "ab")], truncated: false, dropped: 0 });
    expect(truncateDocs([], 5)).toEqual({ documents: [], truncated: false, dropped: 0 });
  });

  it("uses the agent prompt's budget by default", () => {
    const long = "x".repeat(MAX_AGENT_PROMPT_CHARS + 10);
    expect(truncateDocs([doc(1, long)]).documents[0].content).toBe("x".repeat(MAX_AGENT_PROMPT_CHARS) + "\n[...truncated]");
  });
});

describe("readKnowledgeBase", () => {
  it("reads only the documents in call 4570's scope", async () => {
    const db = aiFixtureDb();
    const result = await readKnowledgeBase(callRefs(sampleRow()), db);
    expect(result.value?.documents.map((d) => d.id)).toEqual([1070]);
    expect(result.value).toMatchObject({ scope: { kind: "ids", ids: [1070] }, truncated: false, dropped: 0 });
    expect(db.sent).toEqual([{ sql: expect.stringContaining("AND id = ANY($3)"), params: [77, "caller", [1070]] }]);
  });

  it("reads a document group: completed documents of this business and agent only", async () => {
    const tools = { items: [{ ...kb, context: { document_group: "caller" } }] };
    const result = await readKnowledgeBase(callRefs(sampleRow({ data: { agent_code: "caller", tools } })), aiFixtureDb());
    expect(result.value?.documents.map((d) => d.id)).toEqual([1070, 1071]);
  });

  it("reads every completed document of the business and agent for calls without stored tools", async () => {
    const db = aiFixtureDb();
    const result = await readKnowledgeBase(callRefs(sampleRow({ data: { agent_code: "caller" } })), db);
    expect(result.value?.documents.map((d) => d.id)).toEqual([1070, 1071, 1080]);
    expect(db.sent[0].params).toEqual([77, "caller"]);
  });

  it("returns not_applicable when the agent had no knowledge base tool or the call has no agent_code", async () => {
    const tools = { items: [{ name: "finishConversation" }] };
    expect(await readKnowledgeBase(callRefs(sampleRow({ data: { agent_code: "caller", tools } })), aiFixtureDb())).toMatchObject({
      reason: "not_applicable",
    });
    expect(await readKnowledgeBase(callRefs(sampleRow({ data: {} })), aiFixtureDb())).toMatchObject({ reason: "not_applicable" });
  });

  it("returns an empty knowledge base, not an error, when the business has no documents in scope", async () => {
    for (const data of [{ agent_code: "caller" }, { agent_code: "caller", tools: sample.tools }]) {
      const result = await readKnowledgeBase(callRefs(sampleRow({ business_id: 99, data })), aiFixtureDb());
      expect(result).toMatchObject({ reason: null, value: { documents: [], truncated: false, dropped: 0 } });
    }
  });

  it("returns no documents for an empty id list without querying", async () => {
    const db = aiFixtureDb();
    const tools = { items: [{ ...kb, context: { document_ids: [] } }] };
    const result = await readKnowledgeBase(callRefs(sampleRow({ data: { agent_code: "caller", tools } })), db);
    expect(result.value?.documents).toEqual([]);
    expect(db.sent).toEqual([]);
  });

  it("returns not_configured without AI_DB_*, and query_failed on an error", async () => {
    expect(await readKnowledgeBase(callRefs(sampleRow()), null)).toMatchObject({ value: null, reason: "not_configured" });
    expect(await readKnowledgeBase(callRefs(sampleRow()), throwingDb())).toMatchObject({ value: null, reason: "query_failed" });
  });
});

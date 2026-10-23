import { describe, expect, it } from "bun:test";
import { readAgentInstructions } from "./agent-instructions";
import { callRefs } from "./call-refs";
import { readCallerFlow } from "./caller-flow";
import { aiFixtureDb, sampleRow, vajraFixtureDb } from "./fake-db";
import { readKnowledgeBase } from "./knowledge-base";
import {
  anonymise,
  anonymiseFixture,
  cutDocuments,
  fixtureRow,
  recordingDb,
  redactionsFor,
  replayDb,
  type RecordedFixture,
  type RecordedQuery,
} from "./recorded-fixture";

const fixture = (queries: RecordedQuery[], row = fixtureRow(sampleRow())): RecordedFixture => ({
  _note: "",
  call_id: 4570,
  recorded_at: "",
  max_doc_chars: 500,
  row,
  queries,
});

describe("recordingDb and replayDb", () => {
  it("record what the readers read, and replay gives the readers the same answers", async () => {
    const log: RecordedQuery[] = [];
    const refs = callRefs(sampleRow());
    const live = {
      instructions: await readAgentInstructions(refs, recordingDb(aiFixtureDb(), "ai", log)),
      knowledge: await readKnowledgeBase(refs, recordingDb(aiFixtureDb(), "ai", log)),
      flow: await readCallerFlow(refs, null, recordingDb(vajraFixtureDb(), "vajra", log)),
    };
    expect(log.map((q) => q.db)).toEqual(["ai", "ai", "vajra", "vajra", "vajra"]);

    const recorded = fixture(log);
    expect(await readAgentInstructions(refs, replayDb(recorded, "ai"))).toEqual(live.instructions);
    expect(await readKnowledgeBase(refs, replayDb(recorded, "ai"))).toEqual(live.knowledge);
    expect(await readCallerFlow(refs, null, replayDb(recorded, "vajra"))).toEqual(live.flow);
  });

  it("replay refuses a query that wasn't recorded, or was recorded for the other db", async () => {
    const recorded = fixture([{ db: "ai", sql: "SELECT id FROM prompts WHERE id = $1", params: [1], rows: [{ id: 1 }] }]);
    expect(await replayDb(recorded, "ai").query("SELECT id FROM prompts WHERE id = $1", [1])).toEqual([{ id: 1 }]);
    await expect(replayDb(recorded, "ai").query("SELECT id FROM prompts WHERE id = $1", [2])).rejects.toThrow("not recorded");
    await expect(replayDb(recorded, "vajra").query("SELECT id FROM prompts WHERE id = $1", [1])).rejects.toThrow("not recorded");
  });
});

describe("fixtureRow", () => {
  it("keeps only the columns the readers use", () => {
    const row = fixtureRow({
      ...sampleRow(),
      phone_number: "+919876543210",
      transcriptions: [{ speaker: "user", text: "hi" }],
      recording_url: "s3://x",
      data: JSON.stringify({
        agent_code: "caller",
        metadata: { phone: "+919876543210" },
        config: { prompt_code: "p", variables: { a: 1 }, voice: "x" },
      }),
    });
    expect(row).toEqual({
      id: 4570,
      business_id: 77,
      call_type: "outbound",
      system_ref_id: "conversation:2105",
      data: { agent_code: "caller", config: { prompt_code: "p", variables: { a: 1 } }, tools: null },
    });
  });
});

describe("redactionsFor and anonymise", () => {
  const row = {
    data: {
      config: { variables: { name: "Asha Rao", agent_name: "Anjali", contact_id: "2500", call_type: "outbound", company_name: "Acme" } },
      metadata: { name: "Asha", phone: "+91 98765 43210", tag: "vip" },
    },
    meta_data: JSON.stringify({ email: "asha@example.com" }),
  };

  it("collects personal-looking values, longest first, skipping ids and other keys", () => {
    expect(redactionsFor(row, ["Rohan"])).toEqual([
      ["asha@example.com", "<EMAIL>"],
      ["+91 98765 43210", "<PHONE>"],
      ["Asha Rao", "<NAME>"],
      ["Anjali", "<AGENT_NAME>"],
      ["Rohan", "<REDACTED>"],
      ["Asha", "<NAME>"],
      ["Acme", "<COMPANY_NAME>"],
    ]);
  });

  it("replaces them in every string, plus emails and 10+ digit phones, leaving dates, ids and keys alone", () => {
    const value = {
      text: "Hi Asha Rao, this is Anjali from Acme. Call 98765-43210 or mail a.b@x.io on 2026-10-12, case 711.",
      nested: [{ name: "Asha" }, 919876543210, 2105],
    };
    expect(anonymise<unknown>(value, redactionsFor(row))).toEqual({
      text: "Hi <NAME>, this is <AGENT_NAME> from <COMPANY_NAME>. Call <PHONE> or mail <EMAIL> on 2026-10-12, case 711.",
      nested: [{ name: "<NAME>" }, "<PHONE>", 2105],
    });
  });

  it("anonymises the row, params and rows of a recording but never its SQL, so replay still matches", async () => {
    const recorded = fixture(
      [
        {
          db: "ai",
          sql: "SELECT id FROM prompts WHERE prompt_code = $1 -- Acme",
          params: ["Acme_prompt"],
          rows: [{ system_prompt: "Acme rules" }],
        },
      ],
      fixtureRow({ id: 1, business_id: 2, data: { agent_code: "Acme", config: { prompt_code: "Acme_prompt" } } }),
    );
    const out = anonymiseFixture(recorded, [["Acme", "<REDACTED>"]]);
    expect(out.row.data).toMatchObject({ agent_code: "<REDACTED>", config: { prompt_code: "<REDACTED>_prompt" } });
    expect(out.queries[0]).toEqual({
      db: "ai",
      sql: "SELECT id FROM prompts WHERE prompt_code = $1 -- Acme",
      params: ["<REDACTED>_prompt"],
      rows: [{ system_prompt: "<REDACTED> rules" }],
    });
    expect(await replayDb(out, "ai").query(recorded.queries[0].sql, ["<REDACTED>_prompt"])).toEqual([
      { system_prompt: "<REDACTED> rules" },
    ]);
  });
});

describe("redactionsFor first names", () => {
  it("also redacts the first word of a multi-word name, which prompts use on its own", () => {
    const row = { data: { config: { variables: { name: "Krishna Iyer", agent_name: "Anjali Rao", phone_name: "xy" } } } };
    expect(redactionsFor(row)).toEqual([
      ["Krishna Iyer", "<NAME>"],
      ["Anjali Rao", "<AGENT_NAME>"],
      ["Krishna", "<NAME>"],
      ["Anjali", "<AGENT_NAME>"],
    ]);
  });
});

describe("anonymise and identifiers", () => {
  it("leaves Vajra node ids, edge ends and ms timestamps alone, so the flow graph survives", () => {
    const graph = {
      nodes: [{ id: "discuss-1712345678901", name: "Ask Asha", data: { at: 1712345678901 } }],
      edges: [{ id: "xy-edge__discuss-1712345678901-say-1712345678902", source: "discuss-1712345678901", target: "say-1712345678902" }],
      conversation_node_id: "start-conv-1",
      text: "See discuss-1712345678901, or call +91 98765 43210.",
    };
    expect(anonymise(graph, [["Asha", "<NAME>"]])).toEqual({
      nodes: [{ id: "discuss-1712345678901", name: "Ask <NAME>", data: { at: 1712345678901 } }],
      edges: graph.edges,
      conversation_node_id: "start-conv-1",
      text: "See discuss-1712345678901, or call <PHONE>.",
    });
  });
});

describe("cutDocuments", () => {
  it("cuts knowledge base content past the limit and leaves other queries alone", () => {
    const queries: RecordedQuery[] = [
      {
        db: "ai",
        sql: "SELECT id, content FROM knowledgebase_documents",
        params: [],
        rows: [
          { id: 1, content: "abcdef" },
          { id: 2, content: "ab" },
          { id: 3, content: null },
        ],
      },
      { db: "ai", sql: "SELECT id FROM prompts", params: [], rows: [{ id: 9, system_prompt: "abcdef" }] },
    ];
    expect(cutDocuments(queries, 3)).toEqual([
      {
        ...queries[0],
        rows: [
          { id: 1, content: "abc [...cut for the fixture]" },
          { id: 2, content: "ab" },
          { id: 3, content: null },
        ],
      },
      queries[1],
    ]);
  });
});

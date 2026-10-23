import { describe, expect, it } from "bun:test";
import { readAgentInstructions } from "./v2/agent-instructions";
import { callRefs } from "./v2/call-refs";
import { readCallerFlow } from "./v2/caller-flow";
import { aiFixtureDb, sampleRow, vajraFixtureDb, type SentQuery } from "./v2/fake-db";
import { readKnowledgeBase } from "./v2/knowledge-base";
import { env } from "@/env";
import type { PoolConfig } from "pg";
import { aiDb } from "./ai.db";
import { assertSelect, readOnlyDb } from "./readonly-db";
import { vajraDb } from "./vajra.db";

const cfg = { host: "db", port: 5432, user: "reader", password: "", database: "ai", ssl: false };

describe("readOnlyDb", () => {
  it("is null unless host, user and database are all set", () => {
    expect(readOnlyDb({ ...cfg, host: undefined })).toBeNull();
    expect(readOnlyDb({ ...cfg, user: undefined })).toBeNull();
    expect(readOnlyDb({ ...cfg, database: undefined })).toBeNull();
    expect(readOnlyDb(cfg)).not.toBeNull();
  });

  it("refuses anything but a single SELECT before connecting", async () => {
    const db = readOnlyDb(cfg)!;
    for (const sql of [
      "UPDATE prompts SET version = 2",
      "DELETE FROM prompts",
      "SELECT 1; DROP TABLE prompts",
      "WITH x AS (DELETE FROM a) SELECT 1",
    ]) {
      await expect(db.query(sql)).rejects.toThrow("only single SELECT");
    }
    expect(() => assertSelect("  select id FROM prompts WHERE id = $1;")).not.toThrow();
  });

  it("opens one lazy, read-only, time-limited pool and returns the rows", async () => {
    const configs: PoolConfig[] = [];
    const sent: unknown[][] = [];
    const db = readOnlyDb({ ...cfg, ssl: true }, (config) => {
      configs.push(config);
      return { query: (async (sql: string, params: unknown[]) => (sent.push([sql, params]), { rows: [{ id: 1 }] })) as any };
    })!;
    expect(configs).toEqual([]);
    expect(await db.query("SELECT id FROM prompts WHERE id = $1", [1])).toEqual([{ id: 1 }]);
    await db.query("SELECT id FROM prompts");
    expect(configs).toEqual([
      {
        host: "db",
        port: 5432,
        user: "reader",
        password: "",
        database: "ai",
        ssl: { rejectUnauthorized: false },
        options: "-c default_transaction_read_only=on",
        statement_timeout: 10_000,
        max: 2,
      },
    ]);
    expect(sent).toEqual([
      ["SELECT id FROM prompts WHERE id = $1", [1]],
      ["SELECT id FROM prompts", []],
    ]);
    const plain: PoolConfig[] = [];
    await readOnlyDb(cfg, (config) => (plain.push(config), { query: (async () => ({ rows: [] })) as any }))!.query("SELECT 1");
    expect(plain[0].ssl).toBeUndefined();
  });

  it("builds aiDb and vajraDb from AI_DB_* and VAJRA_DB_*, null when either isn't fully set", () => {
    expect(aiDb() !== null).toBe(Boolean(env.AI_DB_HOSTNAME && env.AI_DB_USERNAME && env.AI_DB_NAME));
    expect(vajraDb() !== null).toBe(Boolean(env.VAJRA_DB_HOSTNAME && env.VAJRA_DB_USERNAME && env.VAJRA_DB_NAME));
  });
});

// Every column a reader may select; anything else (phone numbers, tokens, transcripts) is never read.
const ALLOWED: Record<string, string[]> = {
  prompts: ["id", "prompt_code", "agent_code", "business_id", "version", "model", "system_prompt"],
  knowledgebase_documents: ["id", "document_id", "title", "document_group", "agent_code", "content"],
  conversations: ["id", "business_id", "workflow_execution_id", "conversation_node_id"],
  workflow_executions: ["id", "workflow_id", "workflow_version_id"],
  workflow_versions: ["id", "workflow_id", "version", "nodes", "edges"],
};

describe("every v2 reader", () => {
  it("sends only SELECTs on named, allowed columns", async () => {
    const ai = aiFixtureDb();
    const vajra = vajraFixtureDb();
    const refs = callRefs(sampleRow());
    await readAgentInstructions(refs, ai);
    await readKnowledgeBase(refs, ai);
    await readKnowledgeBase(callRefs(sampleRow({ data: { agent_code: "caller" } })), ai);
    await readCallerFlow(refs, null, vajra);

    const sent: SentQuery[] = [...ai.sent, ...vajra.sent];
    expect(sent.length).toBe(6);
    for (const { sql } of sent) {
      expect(() => assertSelect(sql)).not.toThrow();
      const [, columns, table] = sql.match(/^\s*SELECT\s+([\s\S]+?)\s+FROM\s+(\w+)/i)!;
      expect(Object.keys(ALLOWED)).toContain(table);
      for (const column of columns.split(",").map((c) => c.trim())) expect(ALLOWED[table]).toContain(column);
    }
  });
});

import aiService from "../../../fixtures/readers/ai-service.json";
import vajra from "../../../fixtures/readers/vajra.json";
import sample from "../../../fixtures/call-sample.json";
import type { ReadOnlyDb } from "@/services/readonly-db";

/**
 * Test helpers for the v2 readers: a `ReadOnlyDb` that answers from the recorded rows in `fixtures/readers/` and keeps
 * every query it was sent, so tests can check the SQL. Never a live database.
 */
export type SentQuery = { sql: string; params: unknown[] };
export type FakeDb = ReadOnlyDb & { sent: SentQuery[] };

export function fakeDb(answer: (table: string, params: unknown[]) => any[]): FakeDb {
  const sent: SentQuery[] = [];
  return {
    sent,
    async query(sql, params = []) {
      sent.push({ sql, params });
      const table = sql.match(/\bFROM\s+(\w+)/i)?.[1] ?? "";
      return answer(table, params);
    },
  };
}

/** Answers the readers' SELECTs from the ai-service fixture, applying the same filters their WHERE clauses do. */
export const aiFixtureDb = () =>
  fakeDb((table, [first, second, third]) => {
    if (table === "prompts") {
      return aiService.prompts.filter(
        (p) => p.prompt_code === first && p.agent_code === second && (p.business_id === null || p.business_id === third),
      );
    }
    if (table === "knowledgebase_documents") {
      // $3 is the ids (numbers) or the groups (strings) of the scope; absent for "all"
      const scope = third as (number | string)[] | undefined;
      return aiService.knowledgebase_documents
        .filter((d) => d.business_id === first && d.agent_code === second && d.status === "completed")
        .filter((d) => !scope || scope.includes(typeof scope[0] === "number" ? d.id : d.document_group))
        .map(({ status: _status, business_id: _business, ...columns }) => columns);
    }
    return [];
  });

/** Answers the caller-flow SELECTs from the Vajra fixture, by id (and business for conversations). */
export const vajraFixtureDb = () =>
  fakeDb((table, [id, business]) => {
    if (table === "conversations") return vajra.conversations.filter((c) => c.id === id && c.business_id === business);
    if (table === "workflow_executions") return vajra.workflow_executions.filter((e) => e.id === id);
    if (table === "workflow_versions") return vajra.workflow_versions.filter((v) => v.id === id);
    return [];
  });

/** Anonymised call 4570 as a `voice_call_logs` row, placed by Vajra conversation 2105 for business 77. */
export const sampleRow = (over: Record<string, unknown> = {}) => ({
  id: sample.id,
  business_id: 77,
  call_type: sample.call_type,
  system_ref_id: "conversation:2105",
  data: { agent_code: "caller", config: sample.config, tools: sample.tools },
  ...over,
});

export const throwingDb = (message = "connection refused"): FakeDb => {
  const db = fakeDb(() => []);
  return { ...db, query: async () => Promise.reject(new Error(message)) };
};

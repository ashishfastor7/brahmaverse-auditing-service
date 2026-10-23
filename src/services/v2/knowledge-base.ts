import { MAX_AGENT_PROMPT_CHARS } from "@/audit/judge/prompt";
import { aiDb } from "@/services/ai.db";
import type { ReadOnlyDb } from "@/services/readonly-db";
import type { CallRefs, CallTools } from "./call-refs";
import { found, guard, unavailable, type ReadResult } from "./read-result";

/**
 * Which documents the agent could search on this call. `ids` are `knowledgebase_documents.id` (row ids, not the
 * `document_id` string). `all` is for calls from before late September 2026, which stored no tools.
 */
export type KbScope = { kind: "ids"; ids: number[] } | { kind: "group"; groups: string[] } | { kind: "all" } | { kind: "none" };

const list = (v: unknown): unknown[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

/**
 * The scope ai-service's `search_knowledgebase` searched with. At dial time the call's `tools.context` is merged over
 * the item's own context (voice-call-tools.service.ts), and `document_ids` wins over `document_group`
 * (mcp/tools/knowledgebase.ts). Pure.
 */
export function kbScope(tools: CallTools | null): KbScope {
  if (!tools) return { kind: "all" };
  const item = tools.items?.find((i) => i?.name === "search_knowledgebase");
  if (!item) return { kind: "none" };
  const context = { ...item.context, ...tools.context };
  const ids = list(context.document_ids)
    .map(Number)
    .filter((id) => Number.isInteger(id) && id > 0);
  if (context.document_ids !== undefined) return { kind: "ids", ids };
  const groups = list(context.document_group).map(String).filter(Boolean);
  return groups.length ? { kind: "group", groups } : { kind: "all" };
}

export type KbDocument = {
  id: number;
  document_id: string;
  title: string | null;
  document_group: string | null;
  agent_code: string;
  content: string | null;
};

const KB_COLUMNS = `id, document_id, title, document_group, agent_code, content`;
// ai-service always sends the call's agent_code as `app_code`, so the search is narrowed to the agent's documents
const KB_WHERE = `business_id = $1 AND agent_code = $2 AND status = 'completed'`;

/** The SELECT for a scope; null for `none`. Exported for the SQL tests. */
export function kbQuery(scope: KbScope, refs: CallRefs): { sql: string; params: unknown[] } | null {
  const base = [refs.business_id, refs.agent_code];
  const sql = (extra: string) => `SELECT ${KB_COLUMNS} FROM knowledgebase_documents WHERE ${KB_WHERE}${extra} ORDER BY id`;
  if (scope.kind === "ids") return { sql: sql(` AND id = ANY($3)`), params: [...base, scope.ids] };
  if (scope.kind === "group") return { sql: sql(` AND document_group = ANY($3)`), params: [...base, scope.groups] };
  if (scope.kind === "all") return { sql: sql(""), params: base };
  return null;
}

export type KnowledgeBase = { scope: KbScope; documents: KbDocument[]; truncated: boolean; dropped: number };

const TRUNCATED = "\n[...truncated]";

/** Fits the documents into the judge's prompt budget, cut the way the agent prompt is; later documents go first. Pure. */
export function truncateDocs(
  docs: KbDocument[],
  max = MAX_AGENT_PROMPT_CHARS,
): { documents: KbDocument[]; truncated: boolean; dropped: number } {
  let left = max;
  const documents: KbDocument[] = [];
  for (const doc of docs) {
    if (left <= 0) break;
    const content = doc.content ?? "";
    documents.push(content.length > left ? { ...doc, content: content.slice(0, left) + TRUNCATED } : { ...doc, content });
    left -= content.length;
  }
  const dropped = docs.length - documents.length;
  return { documents, truncated: left < 0 || dropped > 0, dropped };
}

/** Knowledge base documents in the call's scope, read from ai-service's `knowledgebase_documents` over `AI_DB_*`. */
export async function readKnowledgeBase(refs: CallRefs, db: ReadOnlyDb | null = aiDb()): Promise<ReadResult<KnowledgeBase>> {
  const scope = kbScope(refs.tools);
  if (!refs.agent_code) return unavailable("not_applicable", "call has no agent_code");
  const query = kbQuery(scope, refs);
  if (!query) return unavailable("not_applicable", "agent had no search_knowledgebase tool on this call");
  if (scope.kind === "ids" && !scope.ids.length) return found({ scope, documents: [], truncated: false, dropped: 0 });
  if (!db) return unavailable("not_configured", "AI_DB_* is not set");
  return guard("knowledge-base", async () => {
    const rows = await db.query<KbDocument>(query.sql, query.params);
    return found({ scope, ...truncateDocs(rows) });
  });
}

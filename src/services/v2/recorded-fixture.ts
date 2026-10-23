import type { ReadOnlyDb } from "@/services/readonly-db";
import { parseJson } from "@/audit/normalize";

/**
 * Real rows the v2 readers read for one call, recorded by `bun run record:readers` into
 * `fixtures/readers/recorded/call-<id>.json` and replayed by recorded.test.ts. Every query the readers sent is
 * stored with its answer, so a replay sees exactly what the live databases returned.
 */
export type RecordedQuery = { db: "ai" | "vajra"; sql: string; params: unknown[]; rows: any[] };
export type RecordedFixture = {
  _note: string;
  call_id: number;
  recorded_at: string;
  max_doc_chars: number;
  /** The `voice_call_logs` columns `callRefs` reads, anonymised. */
  row: { id: number; business_id: number; call_type: string | null; system_ref_id: string | null; data: Record<string, unknown> };
  queries: RecordedQuery[];
};

/** Wraps a live db and keeps every query and its rows. */
export function recordingDb(db: ReadOnlyDb, name: RecordedQuery["db"], log: RecordedQuery[]): ReadOnlyDb {
  return {
    async query(sql, params = []) {
      const rows = await db.query(sql, params);
      log.push({ db: name, sql, params, rows });
      return rows;
    },
  };
}

/** Answers from a recording: the same SQL and params get the recorded rows; anything else is an error. */
export function replayDb(fixture: RecordedFixture, name: RecordedQuery["db"]): ReadOnlyDb {
  return {
    async query(sql, params = []) {
      const hit = fixture.queries.find((q) => q.db === name && q.sql === sql && JSON.stringify(q.params) === JSON.stringify(params));
      if (!hit) throw new Error(`query not recorded for call ${fixture.call_id}: ${sql.split("\n")[0]} ${JSON.stringify(params)}`);
      return hit.rows;
    },
  };
}

/** The `voice_call_logs` columns the readers use; transcript, phone numbers, recording and metadata are left out. */
export function fixtureRow(row: any): RecordedFixture["row"] {
  const data = parseJson<any>(row.data, null) ?? {};
  return {
    id: Number(row.id),
    business_id: Number(row.business_id),
    call_type: row.call_type ?? null,
    system_ref_id: row.system_ref_id ?? null,
    data: {
      agent_code: data.agent_code ?? null,
      config: { prompt_code: data.config?.prompt_code ?? null, variables: data.config?.variables ?? {} },
      tools: data.tools ?? null,
    },
  };
}

const PERSONAL_KEY = /name|phone|mobile|whatsapp|email|company|business|contact|number/i;
const ID_KEY = /_ids?$/i;

/**
 * What to replace before committing: string values of personal-looking keys in the call's variables and metadata
 * (`name: "Asha"` → `<NAME>`), plus any `extra` terms (a company name, a product) as `<REDACTED>`. Longest first, so
 * "Asha Rao" goes before "Asha". Pure.
 */
export function redactionsFor(row: any, extra: string[] = []): [string, string][] {
  const data = parseJson<any>(row.data, null) ?? {};
  const sources = [data.config?.variables, data.metadata, parseJson<any>(row.meta_data, null)];
  const pairs = new Map<string, string>();
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    for (const [key, value] of Object.entries(source)) {
      // ids (contact_id, document_ids) aren't personal, and numbers are left to the phone rule in `anonymise`
      if (!PERSONAL_KEY.test(key) || ID_KEY.test(key) || typeof value !== "string") continue;
      const text = value.trim();
      if (text.length >= 3 && !pairs.has(text)) pairs.set(text, `<${key.toUpperCase()}>`);
      // a person's first name on its own ("Hi Krishna"), which prompts use as often as the full name
      const first = text.split(/\s+/)[0];
      if (/name/i.test(key) && first !== text && first.length >= 3 && !pairs.has(first)) pairs.set(first, `<${key.toUpperCase()}>`);
    }
  }
  for (const term of extra) if (term.trim().length >= 2) pairs.set(term.trim(), "<REDACTED>");
  return [...pairs].sort((a, b) => b[0].length - a[0].length);
}

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
// not digits glued to a word or an id: Vajra node ids end in a ms timestamp ("discuss-1712345678901")
const PHONE_LIKE = /(?<![\w-])\+?\d[\d\s-]{8,}\d(?!\w)/g;
/** Keys whose values are identifiers, never personal: kept exactly as recorded, so the flow graph and replay match. */
const IDENTIFIER_KEY = /^(id|source|target)$|_ids?$/i;
/** 10 to 12 digits: a phone stored as a number. 13-digit ms timestamps stay. */
const isPhoneNumber = (n: number) => Number.isInteger(n) && Math.abs(n) >= 1e9 && Math.abs(n) < 1e12;

/**
 * Replaces the redactions, emails and phone numbers (10+ digits, so dates stay) in every string, and phones stored as
 * numbers, with placeholders. Values under identifier keys (`id`, `source`, `target`, `*_id`) are left alone. Pure.
 */
export function anonymise<T>(value: T, redactions: [string, string][]): T {
  const text = (s: string) => {
    let out = s;
    for (const [from, to] of redactions) out = out.split(from).join(to);
    return out.replace(EMAIL, "<EMAIL>").replace(PHONE_LIKE, (m) => (m.replace(/\D/g, "").length >= 10 ? "<PHONE>" : m));
  };
  const walk = (v: any): any =>
    typeof v === "string"
      ? text(v)
      : typeof v === "number" && isPhoneNumber(v)
        ? "<PHONE>"
        : Array.isArray(v)
          ? v.map(walk)
          : v && typeof v === "object"
            ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, IDENTIFIER_KEY.test(k) ? x : walk(x)]))
            : v;
  return walk(value);
}

/**
 * Anonymises a recording the way replay needs it: the row and the recorded params and rows, never the SQL. The
 * readers build their params from the (anonymised) row, so recorded params must change the same way to match.
 */
export function anonymiseFixture(fixture: RecordedFixture, redactions: [string, string][]): RecordedFixture {
  return {
    ...fixture,
    row: anonymise(fixture.row, redactions),
    queries: fixture.queries.map((q) => ({ ...q, params: anonymise(q.params, redactions), rows: anonymise(q.rows, redactions) })),
  };
}

/** Cuts recorded knowledge base documents: tests need their ids and shape, not the full business text. Pure. */
export function cutDocuments(queries: RecordedQuery[], maxChars: number): RecordedQuery[] {
  return queries.map((q) =>
    /FROM knowledgebase_documents/.test(q.sql)
      ? {
          ...q,
          rows: q.rows.map((d) =>
            typeof d.content === "string" && d.content.length > maxChars
              ? { ...d, content: `${d.content.slice(0, maxChars)} [...cut for the fixture]` }
              : d,
          ),
        }
      : q,
  );
}

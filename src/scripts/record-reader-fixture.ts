/**
 * Records the real rows the v2 readers read for one call into fixtures/readers/recorded/call-<id>.json, so
 * recorded.test.ts can replay them. Manual only; tests never record. Runs the readers themselves over the
 * read-only connections (SOURCE_DB_*, AI_DB_*, VAJRA_DB_*), so the recorded queries are exactly theirs.
 *
 *   bun run record:readers --call-id 4570 [--max-doc-chars 500] [--redact "Acme Corp" --redact "Rohan"]
 *
 * Names, phones and emails from the call's variables and metadata are replaced automatically. Company, product or
 * staff names that only appear in prompts or documents are not: pass them with --redact, and read the file before
 * committing it.
 */
import { aiDb } from "@/services/ai.db";
import { getSourceCall, sourceDbConfigured } from "@/services/call-source.db";
import { readAgentInstructions } from "@/services/v2/agent-instructions";
import { callRefs } from "@/services/v2/call-refs";
import { readCallerFlow } from "@/services/v2/caller-flow";
import { readKnowledgeBase } from "@/services/v2/knowledge-base";
import {
  anonymiseFixture,
  cutDocuments,
  fixtureRow,
  recordingDb,
  redactionsFor,
  type RecordedFixture,
  type RecordedQuery,
} from "@/services/v2/recorded-fixture";
import { vajraDb } from "@/services/vajra.db";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    "call-id": { type: "string" },
    "max-doc-chars": { type: "string", default: "500" },
    redact: { type: "string", multiple: true, default: [] },
  },
});
const callId = Number(args["call-id"]);
const maxDocChars = Number(args["max-doc-chars"]);
if (!Number.isInteger(callId) || callId <= 0) throw new Error("--call-id must be a call id, e.g. --call-id 4570");
if (!Number.isInteger(maxDocChars) || maxDocChars < 0) throw new Error("--max-doc-chars must be a whole number");
if (!sourceDbConfigured()) throw new Error("SOURCE_DB_* is not set (needed to read the call)");
const ai = aiDb();
const vajra = vajraDb();
if (!ai || !vajra) throw new Error(`${!ai ? "AI_DB_*" : "VAJRA_DB_*"} is not set: a recording without it would hold nothing to replay`);

const source = await getSourceCall(callId);
if (!source) throw new Error(`call ${callId} not found in voice_call_logs`);

const queries: RecordedQuery[] = [];
const refs = callRefs(source);
const instructions = await readAgentInstructions(refs, recordingDb(ai, "ai", queries));
const knowledge = await readKnowledgeBase(refs, recordingDb(ai, "ai", queries));
const flow = await readCallerFlow(refs, null, recordingDb(vajra, "vajra", queries));

const recording: RecordedFixture = {
  _note:
    "Real rows recorded by `bun run record:readers` and anonymised (names, phones and emails replaced; knowledge base " +
    "documents cut). Replayed by src/services/v2/recorded.test.ts. Re-record rather than edit by hand.",
  call_id: callId,
  recorded_at: new Date().toISOString(),
  max_doc_chars: maxDocChars,
  row: fixtureRow(source),
  queries: cutDocuments(queries, maxDocChars),
};
const fixture = anonymiseFixture(recording, redactionsFor(source, args.redact));

const dir = join(import.meta.dir, "../../fixtures/readers/recorded");
mkdirSync(dir, { recursive: true });
const file = join(dir, `call-${callId}.json`);
writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);

const status = (r: { reason: string | null; detail?: string }) => (r.reason ? `${r.reason} (${r.detail})` : "found");
console.log(`call ${callId}: ${queries.length} queries recorded to ${file}`);
console.log(`  instructions: ${status(instructions)}`);
console.log(`  knowledge base: ${status(knowledge)}${knowledge.value ? `, ${knowledge.value.documents.length} documents` : ""}`);
console.log(`  flow: ${flow.source === "vajra" ? `vajra, ${flow.steps.length} steps` : `prompt fallback (${flow.reason})`}`);
console.log("Read the file before committing: company or staff names in prompts and documents need --redact.");
process.exit(0);

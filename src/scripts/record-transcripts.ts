/**
 * Records real calls for the v2 signal tests into fixtures/transcripts/call-<id>.json. Manual only; tests never
 * record. Reads `voice_call_logs` over the read-only SOURCE_DB_* connection.
 *
 *   bun run record:transcripts --call-id 4572 --call-id 4431 [--redact "Acme Corp" --redact "Rohan"]
 *
 * Only what the checks read is kept: no call variables, phone numbers, recording or metadata. Names, phones and emails
 * from the call's variables and metadata are replaced automatically; names the caller says aloud are not (older calls
 * have no variables at all). Pass them with --redact, and read every file before committing it.
 */
import { getSourceCall, sourceDbConfigured } from "@/services/call-source.db";
import { transcriptFixture } from "@/services/v2/recorded-fixture";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    "call-id": { type: "string", multiple: true, default: [] },
    redact: { type: "string", multiple: true, default: [] },
  },
});
const callIds = args["call-id"].map(Number);
if (callIds.length === 0 || callIds.some((id) => !Number.isInteger(id) || id <= 0)) {
  throw new Error("--call-id must be a call id, e.g. --call-id 4572 (repeat it for more calls)");
}
if (!sourceDbConfigured()) throw new Error("SOURCE_DB_* is not set (needed to read the calls)");

const dir = join(import.meta.dir, "../../fixtures/transcripts");
mkdirSync(dir, { recursive: true });

for (const id of callIds) {
  const source = await getSourceCall(id);
  if (!source) throw new Error(`call ${id} not found in voice_call_logs`);
  const row = transcriptFixture(source, args.redact);
  const fixture = {
    _note: "Real call recorded by `bun run record:transcripts` and anonymised. Re-record rather than edit by hand.",
    recorded_at: new Date().toISOString(),
    ...row,
  };
  const file = join(dir, `call-${id}.json`);
  writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`call ${id}: ${row.transcriptions.length} turns recorded to ${file}`);
}
console.log("Read every file before committing: names the caller said aloud need --redact.");
process.exit(0);

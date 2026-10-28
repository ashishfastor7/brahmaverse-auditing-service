import { normalizeCall, parseJson } from "@/audit/normalize";
import type { Turn } from "@/audit/types";

/**
 * A save tool the agent could call, from `data.tools.items[*].schema`. `wrapper` is the object property the saved
 * fields sit in (Caller's `data`, Hansa's `outcome`), and `required` that object's `required` list; without a wrapper,
 * the schema's own `required`. `outcome` stores the wrapper's fields flat (Caller), or the whole payload under the
 * tool's name (2026-08-20 to 09-08 rows).
 */
export type SaveTool = { name: string; wrapper: string | null; required: string[] };

/** What the v2 system checks and signals read from a stored call. */
export type CallRecord = {
  transcript: Turn[];
  status: string;
  picked_at: string | null;
  ended_reason: string | null;
  outcome: Record<string, unknown> | null;
  save_tools: SaveTool[];
};

function saveTool(item: any): SaveTool | null {
  const schema = item?.schema;
  if (!schema || typeof schema !== "object" || typeof item.name !== "string") return null;
  const objects = Object.entries<any>(schema.properties ?? {}).filter(([, p]) => p?.type === "object" && p.properties);
  const [wrapper, inner] = objects.length === 1 ? objects[0] : [null, schema];
  const required = Array.isArray(inner.required) ? inner.required.filter((r: unknown) => typeof r === "string") : [];
  return { name: item.name, wrapper, required };
}

const isoOrNull = (v: unknown) => {
  const d = v ? new Date(v as string) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
};

/** A `voice_call_logs` row (DB, RPC or fixture) as a `CallRecord`. Turns are numbered as in `normalizeCall`. Pure. */
export function toCallRecord(raw: any): CallRecord {
  const call = normalizeCall(raw);
  const data = parseJson<any>(raw.data, null);
  const items: unknown[] = Array.isArray(data?.tools?.items) ? data.tools.items : [];
  return {
    transcript: call.transcript,
    status: call.status,
    picked_at: isoOrNull(raw.picked_at),
    ended_reason: call.ended_reason,
    outcome: call.outcome && typeof call.outcome === "object" && !Array.isArray(call.outcome) ? call.outcome : null,
    save_tools: items.map(saveTool).filter((t): t is SaveTool => t !== null),
  };
}

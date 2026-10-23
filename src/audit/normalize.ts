import type { AuditInput, Turn } from "./types";

/** JSON columns arrive as objects from the bus but as strings from some DB exports. */
export function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

/**
 * Lines the voice platform injects into the transcript as if the caller said them, e.g. Ultravox's
 * "(New Call) Respond as if you are answering the phone." at the start of inbound calls.
 */
const INJECTED_LINE = /^\((new call|system)\)/i;

function toTurns(raw: unknown): Turn[] {
  const items = parseJson<unknown[]>(raw, []);
  if (!Array.isArray(items)) return [];
  return items
    .map((item: any) => ({
      speaker: String(item?.speaker ?? item?.role ?? "unknown").toLowerCase(),
      text: String(item?.text ?? item?.content ?? "").trim(),
    }))
    .filter((t) => t.text.length > 0 && !INJECTED_LINE.test(t.text))
    .map((t, i) => ({ turn: i + 1, ...t }));
}

const nullableNumber = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
const nullableString = (v: unknown) => (v === null || v === undefined || v === "" ? null : String(v));

/**
 * Accepts any of the shapes a call reaches us in and returns one `AuditInput`:
 * - the `voicecall.ended` event payload (agent_code etc. already lifted out),
 * - a `query.voicecall.list` row (no agent_code — pass it via `overrides`),
 * - a raw `voice_call_logs` row exported from the DB (agent_code inside `data`).
 */
export function normalizeCall(raw: any, overrides: Partial<AuditInput> = {}): AuditInput {
  const data = parseJson<any>(raw.data, null);
  const variables = parseJson<Record<string, any>>(raw.variables ?? data?.config?.variables, {});

  const input: AuditInput = {
    source: "voice_call_logs",
    call_id: Number(raw.id ?? raw.call_id),
    business_id: Number(raw.business_id),
    agent_id: nullableNumber(raw.agent_id),
    agent_code: nullableString(raw.agent_code ?? data?.agent_code),
    prompt_code: nullableString(raw.prompt_code ?? data?.config?.prompt_code),
    variables: variables && typeof variables === "object" ? variables : {},
    status: String(raw.status ?? "unknown"),
    call_type: nullableString(raw.call_type),
    voice_provider: nullableString(raw.voice_provider),
    is_playground: Boolean(raw.is_playground ?? data?.config?.is_playground ?? false),
    duration: nullableNumber(raw.duration),
    ended_reason: nullableString(raw.ended_reason),
    recording_url: nullableString(raw.recording_url),
    summary: nullableString(raw.summary),
    outcome: parseJson<Record<string, unknown> | null>(raw.outcome, null),
    transcript: toTurns(raw.transcriptions ?? raw.transcript),
    call_created_at: raw.created_at ? new Date(raw.created_at).toISOString() : null,
  };
  return { ...input, ...overrides };
}

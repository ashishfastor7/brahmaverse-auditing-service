import { parseJson } from "@/audit/normalize";

/** A tool the call was dialled with (`voice_call_logs.data.tools.items[]`). */
export type ToolItem = { name: string; context?: Record<string, unknown>; schema?: Record<string, unknown> };
export type CallTools = { items?: ToolItem[]; context?: Record<string, unknown> };

/** What the v2 readers need from a `voice_call_logs` row to find the call's data in other services. */
export type CallRefs = {
  call_id: number;
  business_id: number;
  agent_code: string | null;
  prompt_code: string | null;
  call_type: "inbound" | "outbound";
  variables: Record<string, unknown>;
  /** `conversation:<id>` on calls Vajra placed. */
  system_ref_id: string | null;
  /** Null on calls from before late September 2026, which didn't store it. */
  tools: CallTools | null;
  prior_call_id: string | null;
};

const text = (v: unknown) => (v === null || v === undefined || v === "" ? null : String(v));

/** Reads the refs from a raw `voice_call_logs` row (`getSourceCall` selects every column used here). */
export function callRefs(row: any): CallRefs {
  const data = parseJson<any>(row.data, null) ?? {};
  const variables = parseJson<Record<string, unknown>>(data.config?.variables, {});
  const tools = parseJson<CallTools | null>(data.tools, null);
  return {
    call_id: Number(row.id),
    business_id: Number(row.business_id),
    agent_code: text(data.agent_code),
    prompt_code: text(data.config?.prompt_code),
    // ai-service only accepts these two
    call_type: row.call_type === "inbound" ? "inbound" : "outbound",
    variables: variables && typeof variables === "object" ? variables : {},
    system_ref_id: text(row.system_ref_id),
    tools: tools && typeof tools === "object" ? tools : null,
    prior_call_id: text(data.config?.prior_call_id),
  };
}

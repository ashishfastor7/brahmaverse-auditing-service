import type { AgentPrompt, AuditInput } from "@/audit/types";
import { isNoResponders, request } from "./bus";

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: AgentPrompt | null }>();

/**
 * The agent's system prompt for this call, from ai-service's `query.realtime-call.prompt`
 * (added by patches/ai-service-prompt-rpc.patch). Returns null — and the call is graded without
 * it — when the call has no prompt_code or ai-service can't answer.
 */
export async function fetchAgentPrompt(input: AuditInput): Promise<AgentPrompt | null> {
  if (!input.prompt_code || !input.agent_code) return null;
  const payload = {
    agent_code: input.agent_code,
    business_id: input.business_id,
    prompt_code: input.prompt_code,
    call_type: input.call_type === "inbound" ? "inbound" : "outbound",
    variables: input.variables,
  };
  const key = JSON.stringify(payload);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  try {
    const value = await request<AgentPrompt | null>("query.realtime-call.prompt", payload);
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch (e) {
    console.warn(
      `[prompt] call=${input.call_id} prompt unavailable (${isNoResponders(e) ? "ai-service has no query.realtime-call.prompt handler" : (e as Error).message}); grading without it`,
    );
    return null;
  }
}

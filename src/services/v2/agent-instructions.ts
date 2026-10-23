import { renderTemplate } from "@/audit/v2/render-template";
import type { AgentPrompt } from "@/audit/types";
import { aiDb } from "@/services/ai.db";
import type { ReadOnlyDb } from "@/services/readonly-db";
import type { CallRefs } from "./call-refs";
import { found, guard, unavailable, type ReadResult } from "./read-result";

export type PromptRow = {
  id: number;
  prompt_code: string;
  agent_code: string;
  business_id: number | null;
  version: number;
  model: string | null;
  system_prompt: string;
};

export const PROMPT_SQL = `SELECT id, prompt_code, agent_code, business_id, version, model, system_prompt FROM prompts
  WHERE prompt_code = $1 AND agent_code = $2 AND (business_id IS NULL OR business_id = $3)`;

/** ai-service's `findPrompt`: the business's own row wins over the shared one. Lowest id breaks ties, for stability. */
export function pickPrompt(rows: PromptRow[]): PromptRow | null {
  const sorted = [...rows].sort((a, b) => Number(a.business_id === null) - Number(b.business_id === null) || a.id - b.id);
  return sorted[0] ?? null;
}

// ai-service voice-call.rpc.ts: on a resumed Ultravox call this line replaces "Begin now at STEP_1."
const RESUME_INSTRUCTION = `

This call was cut off mid-conversation and has just been redialed. Briefly acknowledge the drop in your first sentence, then carry on from where it stopped.`;

/** ai-service `resolveVoiceProvider`: a `brahmaverse/` model prefix is Vani; anything else runs on Ultravox. */
const isUltravox = (model: string | null) => {
  const slash = model?.indexOf("/") ?? -1;
  return !(slash > 0 && model!.slice(0, slash) === "brahmaverse");
};

/** The prompt as ai-service renders it at dial time: `call_type` plus the call variables (which win). */
export function renderInstructions(row: PromptRow, refs: CallRefs): AgentPrompt {
  const rendered = renderTemplate(row.system_prompt, { call_type: refs.call_type, ...refs.variables });
  const resuming = Boolean(refs.prior_call_id) && isUltravox(row.model);
  return {
    prompt_id: row.id,
    prompt_code: row.prompt_code,
    version: row.version,
    system_prompt: resuming ? rendered.replace("Begin now at STEP_1.", RESUME_INSTRUCTION) : rendered,
  };
}

/**
 * The agent's instructions for this call, read from ai-service's `prompts` over `AI_DB_*`. v2 only; v1 keeps
 * `prompt.service.ts`. This is the prompt as it is today, not necessarily the version used on the call.
 */
export async function readAgentInstructions(refs: CallRefs, db: ReadOnlyDb | null = aiDb()): Promise<ReadResult<AgentPrompt>> {
  if (!refs.prompt_code || !refs.agent_code) return unavailable("not_applicable", "call has no prompt_code or agent_code");
  if (!db) return unavailable("not_configured", "AI_DB_* is not set");
  return guard("agent-instructions", async () => {
    const rows = await db.query<PromptRow>(PROMPT_SQL, [refs.prompt_code, refs.agent_code, refs.business_id]);
    const row = pickPrompt(rows);
    if (!row) return unavailable("not_found", `no prompt ${refs.prompt_code} for agent ${refs.agent_code}`);
    return found(renderInstructions(row, refs));
  });
}

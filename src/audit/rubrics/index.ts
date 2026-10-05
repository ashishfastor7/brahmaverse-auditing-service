import { defaultRubric } from "./default";
import { hansaRubric } from "./hansa";
import type { Rubric } from "./types";

export type Agent = { code: string; label: string; agent_ids: number[]; rubric: Rubric };

/**
 * The Brahmaverse agents. `agent_code` is often empty on call rows (inbound calls and older
 * outbound calls have no queued payload), so agents are also matched on `agent_id`.
 */
export const agents: Agent[] = [
  { code: "hrms", label: "Hansa (HR)", agent_ids: [1], rubric: hansaRubric },
  { code: "project-manager", label: "Project manager", agent_ids: [4], rubric: defaultRubric },
  { code: "caller", label: "Caller", agent_ids: [9], rubric: defaultRubric },
];

/** Resolves the agent from whichever of agent_code / agent_id the call carries. */
export function agentFor(agent_code: string | null, agent_id: number | null): Agent | null {
  const code = agent_code?.toLowerCase();
  return (
    (code ? agents.find((a) => a.code === code) : undefined) ??
    (agent_id !== null ? agents.find((a) => a.agent_ids.includes(agent_id)) : undefined) ??
    null
  );
}

export function rubricFor(agent_code: string | null, agent_id: number | null = null): Rubric {
  return agentFor(agent_code, agent_id)?.rubric ?? defaultRubric;
}

export const rubrics: Rubric[] = [hansaRubric, defaultRubric];

export type { Rubric } from "./types";

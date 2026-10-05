import { defaultRubric } from "./default";
import { hansaRubric } from "./hansa";
import type { Rubric } from "./types";

export const rubrics: Rubric[] = [hansaRubric, defaultRubric];

export function rubricFor(agent_code: string | null): Rubric {
  const code = agent_code?.toLowerCase();
  return rubrics.find((r) => code && r.agent_codes.includes(code)) ?? defaultRubric;
}

export type { Rubric } from "./types";

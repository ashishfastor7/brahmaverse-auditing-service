import type { ReadOnlyDb } from "@/services/readonly-db";
import { vajraDb } from "@/services/vajra.db";
import type { CallRefs } from "./call-refs";
import { found, guard, unavailable, type ReadResult } from "./read-result";

/** The parts of Vajra's node/edge types (vajra-app-service src/types/node.types.ts) the auditor reads. */
export type FlowNode = { id: string; type: string; name?: string | null; data?: Record<string, any> | null };
export type FlowEdge = { id: string; source: string; target: string; label?: string; order?: number };

export type FlowField = { variable: string; data_type: string | null; required: boolean; prompt: string | null };
export type FlowRoute = { step: string; when: string | null };
export type FlowStep = {
  /** The name the agent saw in its prompt: `STEP_n`, `EXIT`, `EXIT_n` or `END`. */
  step: string;
  node_id: string;
  type: string;
  name: string | null;
  /** `instructions` (discuss), `message` (say) or `closing_message` (end), as authored, before rendering. */
  text: string | null;
  fields: FlowField[];
  next: FlowRoute[];
};

export type CallerFlow =
  | {
      source: "vajra";
      conversation_id: number;
      conversation_node_id: string | null;
      workflow_id: number;
      workflow_version_id: number;
      version: number;
      steps: FlowStep[];
      /** `required` fields of `collect` steps. */
      required_fields: string[];
    }
  | { source: "prompt"; text: string | null; reason: string };

// Copied from vajra-app-service src/services/conversation/conversation_prompt.service.ts (buildStepGraph and
// createNavigator), so step names match the compiled `STEP_n` prompt the agent was given. Keep in step with it.
const END_STEP = "END";
const NON_STEP_TYPES = new Set(["start_conversation", "decision"]);
const VARIABLE_FIELD: Record<string, string> = { collect: "fields", discuss: "extract" };
const sanitizeText = (s: string): string => s.replace(/\s*\n+\s*/g, " ").trim();
const closingOf = (node: FlowNode): string => sanitizeText(String(node.data?.closing_message ?? ""));
const fieldsOf = (node: FlowNode): any[] => (VARIABLE_FIELD[node.type] ? (node.data?.[VARIABLE_FIELD[node.type]] ?? []) : []);
const TEXT_KEY: Record<string, string> = { discuss: "instructions", say: "message", end_conversation: "closing_message" };

/** The flow as numbered steps, in the order and with the names Vajra's compiler gives them. Pure. */
export function flowSteps(nodes: FlowNode[], edges: FlowEdge[]): { steps: FlowStep[]; required_fields: string[] } {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const inDegree = new Map(nodes.map((n) => [n.id, 0]));
  const outEdges = new Map<string, FlowEdge[]>(nodes.map((n) => [n.id, []]));
  for (const edge of edges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) continue;
    outEdges.get(edge.source)!.push(edge);
    inDegree.set(edge.target, inDegree.get(edge.target)! + 1);
  }
  for (const list of outEdges.values()) list.sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));

  // Kahn's order; nodes on a cycle keep their authored position after the acyclic part
  const queue = nodes.filter((n) => inDegree.get(n.id) === 0).map((n) => n.id);
  const seen = new Set<string>();
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    if (seen.has(id)) continue;
    seen.add(id);
    for (const edge of outEdges.get(id)!) {
      const degree = inDegree.get(edge.target)! - 1;
      inDegree.set(edge.target, degree);
      if (degree === 0) queue.push(edge.target);
    }
  }
  const sorted = [...Array.from(seen, (id) => nodeById.get(id)!), ...nodes.filter((n) => !seen.has(n.id))];

  const closings = Array.from(
    new Set(
      sorted
        .filter((n) => n.type === "end_conversation")
        .map(closingOf)
        .filter(Boolean),
    ),
  );
  const exitName = (closing: string) => (!closing ? END_STEP : closings.length === 1 ? "EXIT" : `EXIT_${closings.indexOf(closing) + 1}`);
  const stepNameOf = new Map<string, string>();
  let stepNumber = 0;
  for (const node of sorted) {
    if (NON_STEP_TYPES.has(node.type)) continue;
    stepNameOf.set(node.id, node.type === "end_conversation" ? exitName(closingOf(node)) : `STEP_${++stepNumber}`);
  }

  // decisions are folded into the step before them, their conditions joined along the path
  const routesFor = (edge: FlowEdge, when: string | null, pathSeen: ReadonlySet<string>): FlowRoute[] => {
    const target = nodeById.get(edge.target);
    if (!target) return [];
    if (target.type !== "decision") {
      const step = stepNameOf.get(target.id);
      return step ? [{ step, when }] : [];
    }
    if (pathSeen.has(target.id)) return [];
    const nextSeen = new Set(pathSeen).add(target.id);
    const branches = outEdges.get(target.id) ?? [];
    return ((target.data?.paths ?? []) as { label: string; condition?: string }[]).flatMap((path) => {
      const branch = branches.find((e) => e.label === path.label);
      if (!branch) return [];
      const condition = path.condition ? sanitizeText(path.condition) : "";
      return routesFor(branch, condition ? (when ? `${when} AND ${condition}` : condition) : when, nextSeen);
    });
  };

  // listed in the compiled prompt's order: every other step first, then the exits
  const isEnd = (n: FlowNode) => n.type === "end_conversation";
  const steps = [...sorted.filter((n) => !isEnd(n)), ...sorted.filter(isEnd)]
    .filter((n) => stepNameOf.has(n.id))
    .map((node) => {
      const raw = TEXT_KEY[node.type] ? node.data?.[TEXT_KEY[node.type]] : null;
      return {
        step: stepNameOf.get(node.id)!,
        node_id: node.id,
        type: node.type,
        name: node.name ?? null,
        text: raw === null || raw === undefined || raw === "" ? null : String(raw),
        fields: fieldsOf(node)
          .filter((f) => f?.variable)
          .map((f) => ({ variable: f.variable, data_type: f.data_type ?? null, required: Boolean(f.required), prompt: f.prompt ?? null })),
        next: (outEdges.get(node.id) ?? []).flatMap((edge) => routesFor(edge, null, new Set())),
      };
    });

  const required = steps.filter((s) => s.type === "collect").flatMap((s) => s.fields.filter((f) => f.required).map((f) => f.variable));
  return { steps, required_fields: Array.from(new Set(required)) };
}

export const CONVERSATION_SQL = `SELECT id, business_id, workflow_execution_id, conversation_node_id FROM conversations
  WHERE id = $1 AND business_id = $2`;
export const EXECUTION_SQL = `SELECT id, workflow_id, workflow_version_id FROM workflow_executions WHERE id = $1`;
export const VERSION_SQL = `SELECT id, workflow_id, version, nodes, edges FROM workflow_versions WHERE id = $1`;

const CONVERSATION_REF = /^conversation:(\d+)$/;

/** Follows `conversation:<id>` → conversations → workflow_executions → workflow_versions. */
async function readVajraFlow(refs: CallRefs, conversationId: number, db: ReadOnlyDb): Promise<ReadResult<CallerFlow>> {
  const [conversation] = await db.query(CONVERSATION_SQL, [conversationId, refs.business_id]);
  if (!conversation) return unavailable("not_found", `no Vajra conversation ${conversationId}`);
  if (!conversation.workflow_execution_id) return unavailable("not_found", `conversation ${conversationId} has no workflow execution`);
  const [execution] = await db.query(EXECUTION_SQL, [conversation.workflow_execution_id]);
  if (!execution) return unavailable("not_found", `no workflow execution ${conversation.workflow_execution_id}`);
  const [version] = await db.query(VERSION_SQL, [execution.workflow_version_id]);
  if (!version) return unavailable("not_found", `no workflow version ${execution.workflow_version_id}`);
  const { steps, required_fields } = flowSteps(version.nodes ?? [], version.edges ?? []);
  return found<CallerFlow>({
    source: "vajra",
    conversation_id: conversationId,
    conversation_node_id: conversation.conversation_node_id ?? null,
    workflow_id: Number(version.workflow_id),
    workflow_version_id: Number(version.id),
    version: Number(version.version),
    steps,
    required_fields,
  });
}

/**
 * The call's flow. Caller calls placed by Vajra get the structured steps over `VAJRA_DB_*`; every other call (Hansa,
 * Project manager, no Vajra login, or nothing found) falls back to the prompt text: `promptText` when given (the
 * P0-10 instructions), else the compiled `variables.prompt`. Never fails: a fallback carries the reason.
 */
export async function readCallerFlow(
  refs: CallRefs,
  promptText: string | null = null,
  db: ReadOnlyDb | null = vajraDb(),
): Promise<CallerFlow> {
  const text = promptText ?? (typeof refs.variables.prompt === "string" ? refs.variables.prompt : null);
  const fallback = (reason: string): CallerFlow => ({ source: "prompt", text, reason });

  const match = refs.system_ref_id?.match(CONVERSATION_REF);
  if (!match) return fallback("no Vajra conversation on this call");
  if (!db) return fallback("VAJRA_DB_* is not set");
  const result = await guard("caller-flow", () => readVajraFlow(refs, Number(match[1]), db));
  return result.reason === null ? result.value : fallback(result.detail);
}

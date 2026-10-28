import type { CallRecord } from "./call-record";
import { CALL_ERROR_ENDED_REASONS } from "./conditions";
import { turnsEvidence, type Check, type SignalEvidence, type SignalResult } from "./signal";
import { agentLines, similarAgentTurns, type RepetitionParams, type TurnGroup } from "./signals";

/**
 * P1-5, PRD §3.1: the rule parts of the system checks. Pure. The LLM parts (S2 loop and non-response meaning, S3,
 * S4 values matching the transcript) come from the judge. Silence gaps (S2 "long dead air") need per-turn timing,
 * which no stored call has (P0-5), so they are not checked yet.
 */

const agentTurnCount = (record: CallRecord) => record.transcript.filter((t) => t.speaker === "agent").length;
const callerTurns = (record: CallRecord) => record.transcript.filter((t) => t.speaker !== "agent");
const list = (turns: number[]) => turns.join(", ");

export type ConnectedValue = { status: string; picked_at: string | null; agent_turns: number; caller_turns: number };

/**
 * S1 Connected: the call was picked up and the agent spoke. N/A for calls that never connected (not `completed`, or
 * `unjoined`): they count toward the connect rate instead. A few older rows have no `picked_at`; a caller turn in the
 * transcript shows the call was picked up all the same.
 */
export function checkConnected(record: CallRecord): Check<ConnectedValue> {
  const value = { status: record.status, picked_at: record.picked_at, agent_turns: agentTurnCount(record), caller_turns: callerTurns(record).length };
  if (record.status !== "completed" || record.ended_reason === "unjoined") {
    return { result: "na", reason: `Not connected (${record.ended_reason === "unjoined" ? "unjoined" : record.status}).`, value, evidence: [] };
  }
  if (value.agent_turns === 0) return { result: "fail", reason: "The agent never spoke.", value, evidence: [] };
  if (record.picked_at === null && value.caller_turns === 0) {
    return { result: "fail", reason: "No pick-up time and the caller never spoke.", value, evidence: [] };
  }
  return { result: "pass", reason: "Picked up, and the agent spoke.", value, evidence: [] };
}

export type EndedBy = "caller" | "agent" | "error" | "timeout" | "unknown";
export type EndedByValue = { ended_reason: string | null; ended_by: EndedBy };

const ENDED_BY: Record<string, EndedBy> = {
  hangup: "caller",
  caller_hangup: "caller",
  agent_hangup: "agent",
  bot_hangup: "agent",
  timeout: "timeout",
};

export function endedBy(ended_reason: string | null): EndedBy {
  if (!ended_reason) return "unknown";
  if (CALL_ERROR_ENDED_REASONS.includes(ended_reason)) return "error";
  return ENDED_BY[ended_reason] ?? "unknown";
}

/**
 * S2, who ended the call: fails on a technical error (`CALL_ERROR`). The agent hanging up passes here; whether it hung
 * up too early is the judge's `PREMATURE_HANGUP`. N/A without an `ended_reason`.
 */
export function checkEndedBy(record: CallRecord): Check<EndedByValue> {
  const value = { ended_reason: record.ended_reason, ended_by: endedBy(record.ended_reason) };
  if (!record.ended_reason) return { result: "na", reason: "No ended reason on the call.", value, evidence: [] };
  if (value.ended_by !== "error") {
    return { result: "pass", reason: `Ended by ${value.ended_by} (${record.ended_reason}).`, value, evidence: [] };
  }
  const last = record.transcript.at(-1);
  return {
    result: "fail",
    reason: `The call ended on a technical error (${record.ended_reason}).`,
    value,
    evidence: last ? [turnsEvidence([last.turn])] : [],
  };
}

export type LoopValue = { groups: TurnGroup[]; loops: TurnGroup[] };

/**
 * S2, loops: the same agent line `min_repeats` times or more in a row without the conversation moving forward (the
 * Repetition metric's params). A different agent line in between is progress and starts a new run ("Let me note that
 * down" between different questions isn't a loop). A re-ask after a missing or unclear reply doesn't count: a repeat
 * whose caller reply since the agent's previous turn has at most `unclear_reply_max_words` words ("I", "Hmm", or
 * silence). Evidence cites every turn of the loop. N/A when the agent never spoke.
 */
export function checkLoop(record: CallRecord, params: RepetitionParams): Check<LoopValue> {
  const groups = similarAgentTurns(record.transcript, params);
  const lines = agentLines(record.transcript, params.min_chars).map((t) => t.turn);
  const replyWords = new Map<number, number>();
  let words = 0;
  for (const t of record.transcript) {
    if (t.speaker === "agent") {
      replyWords.set(t.turn, words);
      words = 0;
    } else words += t.text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  }
  const runs = (g: TurnGroup) => {
    const out: number[][] = [];
    for (const turn of g.turns) {
      const prev = out.at(-1)?.at(-1);
      const between = prev === undefined ? [] : lines.filter((l) => l > prev && l < turn);
      if (prev === undefined || between.some((l) => !g.turns.includes(l))) out.push([turn]);
      else if (replyWords.get(turn)! > params.unclear_reply_max_words) out.at(-1)!.push(turn);
    }
    return out;
  };
  const loops = groups
    .flatMap((g) => runs(g).map((turns) => ({ turns, similarity: g.similarity })))
    .filter((g) => g.turns.length >= params.min_repeats);
  const value = { groups, loops };
  if (agentTurnCount(record) === 0) return { result: "na", reason: "The agent never spoke.", value, evidence: [] };
  if (loops.length === 0) return { result: "pass", reason: "No line repeated without progress.", value, evidence: [] };
  return {
    result: "fail",
    reason: `The agent repeated itself without progress (turns ${loops.map((g) => list(g.turns)).join("; ")}).`,
    value,
    evidence: loops.map((g) => turnsEvidence(g.turns)),
  };
}

export type NoResponseValue = { unanswered_turns: number[]; asked_question: boolean; ended_by: EndedBy };

/**
 * S2, no response: caller turns after the agent's last turn, ending with a question, on a call the agent (or an error)
 * then ended. A trailing "Okay, bye" isn't a non-response, and neither is a caller hanging up. Mid-call caller turns
 * always get an agent turn after them (split speech like "I" / "Manually" is one reply). N/A when the caller never spoke.
 */
export function checkNoResponse(record: CallRecord): Check<NoResponseValue> {
  const lastAgent = record.transcript.map((t) => t.speaker).lastIndexOf("agent");
  const trailing = record.transcript.slice(lastAgent + 1).filter((t) => t.speaker !== "agent");
  const value = {
    unanswered_turns: trailing.map((t) => t.turn),
    asked_question: trailing.some((t) => t.text.includes("?")),
    ended_by: endedBy(record.ended_reason),
  };
  if (callerTurns(record).length === 0) return { result: "na", reason: "The caller never spoke.", value, evidence: [] };
  if (value.asked_question && (value.ended_by === "agent" || value.ended_by === "error")) {
    return {
      result: "fail",
      reason: `The caller's question (turn ${list(value.unanswered_turns)}) got no reply before the call ended.`,
      value,
      evidence: [turnsEvidence(value.unanswered_turns)],
    };
  }
  return { result: "pass", reason: "Every caller question got a reply.", value, evidence: [] };
}

export type ConversationHandledValue = { ended_by: Check<EndedByValue>; loop: Check<LoopValue>; no_response: Check<NoResponseValue> };

/** The rule parts of S2 together: fails if any part fails, N/A if every part is N/A. Evidence: the failing parts'. */
export function checkConversationHandled(record: CallRecord, repetitionParams: RepetitionParams): Check<ConversationHandledValue> {
  const value = { ended_by: checkEndedBy(record), loop: checkLoop(record, repetitionParams), no_response: checkNoResponse(record) };
  return { ...combine(Object.values(value)), value };
}

function combine(parts: Check<unknown>[]): { result: SignalResult; reason: string; evidence: SignalEvidence[] } {
  const failed = parts.filter((p) => p.result === "fail");
  if (failed.length) return { result: "fail", reason: failed.map((p) => p.reason).join(" "), evidence: failed.flatMap((p) => p.evidence) };
  if (parts.every((p) => p.result === "na")) return { result: "na", reason: "Nothing to check.", evidence: [] };
  return { result: "pass", reason: "Handled: no error ending, loop or unanswered question.", evidence: [] };
}

export type DataSavedValue = { source: "save_tool" | "goal_config" | null; required: string[]; present: string[]; missing: string[] };

const keyOf = (k: string) => k.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The saved fields of one tool: flat in `outcome`, or (2026-08-20 to 09-08 rows) the payload under the tool's name. */
function savedFields(outcome: Record<string, unknown>, tool: { name: string; wrapper: string | null } | null): Record<string, unknown> {
  const payload = tool && isObject(outcome[tool.name]) ? (outcome[tool.name] as Record<string, unknown>) : outcome;
  return tool?.wrapper && isObject(payload[tool.wrapper]) ? (payload[tool.wrapper] as Record<string, unknown>) : payload;
}

/**
 * S4 Data saved, rule part: every required output is present in `outcome`. Required outputs come from the call's save
 * tools (`data.tools`), falling back to the goal config's `required_outputs` on calls without `data`. Keys match
 * ignoring case and punctuation (`current_ctc`, `Current_CTC`); null and "" count as missing.
 * N/A when nothing is required, or when nothing was saved (Open #8, decided 2026-10-28: often the caller hung up
 * before the save step, which S3 judges). No turn to cite: the evidence is the outcome itself (`value.missing`).
 */
export function checkDataSaved(record: CallRecord, fallbackRequired: string[]): Check<DataSavedValue> {
  const tools = record.save_tools.filter((t) => t.required.length > 0);
  const wanted: { key: string; tool: (typeof tools)[number] | null }[] = tools.length
    ? tools.flatMap((tool) => tool.required.map((key) => ({ key, tool })))
    : fallbackRequired.map((key) => ({ key, tool: null }));
  const source: DataSavedValue["source"] = tools.length ? "save_tool" : fallbackRequired.length ? "goal_config" : null;
  const required = wanted.map((w) => w.key);
  const empty = { source, required, present: [], missing: [] } as DataSavedValue;
  if (wanted.length === 0) return { result: "na", reason: "No required outputs for this call.", value: empty, evidence: [] };
  if (!record.outcome || Object.keys(record.outcome).length === 0) {
    return { result: "na", reason: "Nothing was saved.", value: empty, evidence: [] };
  }

  const outcome = record.outcome;
  const has = (w: (typeof wanted)[number]) => {
    const fields = savedFields(outcome, w.tool);
    const hit = Object.entries(fields).find(([k]) => keyOf(k) === keyOf(w.key));
    return hit !== undefined && hit[1] !== null && hit[1] !== "";
  };
  const present = wanted.filter(has).map((w) => w.key);
  const missing = required.filter((k) => !present.includes(k));
  const value = { source, required, present, missing };
  if (missing.length) return { result: "fail", reason: `Required outputs not saved: ${missing.join(", ")}.`, value, evidence: [] };
  return { result: "pass", reason: `All ${required.length} required outputs saved.`, value, evidence: [] };
}

export type SystemCheckCode = "S1" | "S2" | "S3" | "S4";
export type SystemGoal = { result: SignalResult; failed: SystemCheckCode[] };

/**
 * PRD §3.1: the system goal passes when every applicable check passes. N/A checks are left out; all N/A is N/A.
 * S3 is the judge's (P1-7); give it as N/A until it runs.
 */
export function systemGoal(checks: Record<SystemCheckCode, { result: SignalResult }>): SystemGoal {
  const codes = Object.keys(checks) as SystemCheckCode[];
  const failed = codes.filter((c) => checks[c].result === "fail");
  const result = failed.length ? "fail" : codes.every((c) => checks[c].result === "na") ? "na" : "pass";
  return { result, failed };
}

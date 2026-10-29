import type { CallRecord } from "./call-record";
import type { GoalConfig, Metric } from "./config";
import type { Check, Signal } from "./signal";
import {
  LanguageParams,
  RepetitionParams,
  StallingFillerParams,
  languageMatch,
  repetition,
  stallingFiller,
  type LanguageValue,
  type RepetitionValue,
  type StallingFillerValue,
} from "./signals";
import {
  checkConnected,
  checkConversationHandled,
  checkDataSaved,
  type ConnectedValue,
  type ConversationHandledValue,
  type DataSavedValue,
} from "./system-checks";

/**
 * PRD §7 pipeline step 2: everything code measures before the judge runs. The judge gets these as facts it must not
 * contradict, and the audit keeps them. Pure.
 */
export type MeasuredFacts = {
  connected: Check<ConnectedValue>;
  conversation: Check<ConversationHandledValue>;
  data_saved: Check<DataSavedValue>;
  /** Null when the scorecard has no metric with that key. */
  repetition: Signal<RepetitionValue> | null;
  stalling_filler: Signal<StallingFillerValue> | null;
  language: Signal<LanguageValue> | null;
};

/** The loop rule reads the Repetition metric's params, so every v2 scorecard needs that metric (`validateScorecard`). */
export const REPETITION_KEY = "repetition";
export const STALLING_FILLER_KEY = "stalling_filler";
export const LANGUAGE_MATCH_KEY = "language_match";

const paramsOf = (metrics: Pick<Metric, "key" | "params">[], key: string) => metrics.find((m) => m.key === key)?.params;

export function measure(record: CallRecord, metrics: Pick<Metric, "key" | "params">[], goalRequired: string[]): MeasuredFacts {
  const rawRepetition = paramsOf(metrics, REPETITION_KEY);
  if (!rawRepetition) throw new Error(`the scorecard has no ${REPETITION_KEY} metric, which the S2 loop rule needs`);
  const rep = RepetitionParams.parse(rawRepetition);
  const stall = paramsOf(metrics, STALLING_FILLER_KEY);
  const lang = paramsOf(metrics, LANGUAGE_MATCH_KEY);
  return {
    connected: checkConnected(record),
    conversation: checkConversationHandled(record, rep),
    data_saved: checkDataSaved(record, goalRequired),
    repetition: repetition(record, rep),
    stalling_filler: stall ? stallingFiller(record, StallingFillerParams.parse(stall)) : null,
    language: lang ? languageMatch(record, LanguageParams.parse(lang)) : null,
  };
}

/**
 * What the goal config requires the call to capture: the business goal's `required_outputs` and the system checks'
 * `required_variables` (PRD §3.1 S4, §7). Used when the call's save tools list none.
 */
export const goalRequired = (goal: Pick<GoalConfig, "required_outputs" | "system_checks">): string[] => [
  ...new Set([...goal.required_outputs, ...goal.system_checks.required_variables]),
];

/**
 * The outputs the business goal extracts and S4 checks: the call's save-tool `required` fields, else the goal config's
 * (`goalRequired`; the same list `checkDataSaved` uses).
 */
export function requiredOutputs(record: CallRecord, goalRequired: string[]): string[] {
  const fromTools = record.save_tools.flatMap((t) => t.required);
  return [...new Set(fromTools.length ? fromTools : goalRequired)];
}

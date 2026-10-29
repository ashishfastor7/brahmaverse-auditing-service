import { describe, expect, it } from "bun:test";
import { agentPrompt, cases, plantedRow } from "../../../../fixtures/planted/cases";
import { normalizeCall } from "@/audit/normalize";
import { prepareJudgeV2 } from "../audit-call";
import { toCallRecord } from "../call-record";
import { seededDefinitions, seededGoal, seededScorecard } from "../seeded-config";
import { judgedMetrics, judgePlan, JUDGE_PROMPT_VERSION, NO_REASON_CODE } from "./prompt";
import { type JudgeOutputV2, judgeJsonSchemaV2, validateJudgeOutput } from "./schema";

const hansa = seededScorecard("hansa");
const fallback = seededScorecard("default");
const defaults = (s = hansa) => Object.fromEntries(s.metrics.map((m) => [m.key, m.weight]));
const loopCase = cases.find((c) => c.name === "agent-loop")!;
const raw = plantedRow(loopCase, 900000);

function prepare(opts: { scorecard?: typeof hansa; weights?: Record<string, number>; goal?: ReturnType<typeof seededGoal> } = {}) {
  const scorecard = opts.scorecard ?? hansa;
  return prepareJudgeV2(normalizeCall(raw, {}), toCallRecord(raw), {
    scorecard,
    goal: opts.goal ?? seededGoal(scorecard === hansa ? "hrms" : "caller"),
    weights: opts.weights ?? defaults(scorecard),
    definitions: seededDefinitions(),
    instructions: agentPrompt,
    flow: { source: "prompt", text: agentPrompt.system_prompt, reason: "no Vajra conversation on this call" },
    agentLabel: scorecard === hansa ? "Hansa (HR)" : "Caller",
  });
}

describe(`v2 judge prompt (${JUDGE_PROMPT_VERSION}, P1-4)`, () => {
  it("hansa v4: messages and schema (snapshot; any change needs a JUDGE_PROMPT_VERSION bump and approval)", () => {
    const { call } = prepare();
    expect(call.messages).toMatchSnapshot();
    expect(call.schema).toMatchSnapshot();
  });

  it("default v4: messages (snapshot)", () => {
    expect(prepare({ scorecard: fallback }).call.messages).toMatchSnapshot();
  });

  it("sends the LLM and hybrid metrics only: not the rule metric, not those needing audio or timing, not weight 0", () => {
    const sent = (w: Record<string, number>) => prepare({ weights: w }).plan.metrics.map((m) => m.key);
    expect(sent(defaults())).toEqual([
      "flow_adherence",
      "query_handling",
      "troubleshooting",
      "communication_tone",
      "opening_closure",
      "language_match",
      "repetition",
    ]);
    const noTroubleshooting = { ...defaults(), troubleshooting: 0, flow_adherence: 20 };
    expect(sent(noTroubleshooting)).not.toContain("troubleshooting");
    const system = prepare({ weights: noTroubleshooting }).call.messages[0]!.content;
    expect(system).not.toContain("troubleshooting (Troubleshooting)");
    expect(system).not.toContain("interruptions");
    expect(system).not.toContain("stalling_filler (");
  });

  it("sends the scorecard's enabled LLM conditions only", () => {
    const codes = prepare().plan.conditions.map((c) => c.code);
    expect(codes).toContain("DISCRIMINATORY_QUESTION");
    expect(codes).toContain("OUTCOME_MISMATCH");
    expect(codes).toContain("AGENT_LOOP");
    expect(codes).not.toContain("OUTCOME_MISRECORDED"); // default only
    expect(codes).not.toContain("UNRESPONSIVE_AGENT"); // disabled until timing exists
    expect(codes).not.toContain("CALL_ERROR"); // rule
    expect(prepare({ scorecard: fallback }).plan.conditions.map((c) => c.code)).toContain("OUTCOME_MISRECORDED");
  });

  it("states the measured facts, including the loop the rule found", () => {
    const user = prepare().call.messages[1]!.content;
    expect(user).toContain("# Measured facts (computed by code; do not contradict)");
    expect(user).toContain("Same agent line repeated without progress: turns 13, 15, 17.");
  });

  it("offers PARTIAL only when the goal defines partial success; an outcome without reason codes gets NONE", () => {
    expect(prepare().plan.outcomes).toEqual(["ACHIEVED", "NOT_ACHIEVED", "NOT_APPLICABLE"]);
    const goal = { ...seededGoal("hrms"), partial_success: ["Asked for details on WhatsApp"] };
    const plan = prepare({ goal }).plan;
    expect(plan.outcomes).toEqual(["ACHIEVED", "PARTIAL", "NOT_ACHIEVED", "NOT_APPLICABLE"]);
    expect(plan.reasonCodes.PARTIAL).toEqual([NO_REASON_CODE]);
    expect(prepare({ goal }).call.messages[0]!.content).toContain("PARTIAL when:\n- Asked for details on WhatsApp");
  });

  it("does not send Caller's compiled prompt twice when the instructions already contain it", () => {
    const compiled = "## Conversation Flow\nSTEP_1: greet";
    const callerRaw = { ...raw, variables: { ...raw.variables, prompt: compiled } };
    const prepared = (instructions: string) =>
      prepareJudgeV2(normalizeCall(callerRaw, {}), toCallRecord(callerRaw), {
        scorecard: fallback,
        goal: seededGoal("caller"),
        weights: defaults(fallback),
        definitions: seededDefinitions(),
        instructions: { ...agentPrompt, system_prompt: instructions },
        flow: { source: "prompt", text: instructions, reason: "no Vajra conversation on this call" },
        agentLabel: "Caller",
      }).call.messages[1]!.content;
    expect(prepared(`# ROLE\n...\n${compiled}`).match(/STEP_1: greet/g)).toHaveLength(1);
    expect(prepared("# ROLE only")).toContain('"prompt": "## Conversation Flow');
  });

  it("lists a Vajra flow's steps with required fields and routes; says so when there is no flow or no instructions", () => {
    const user = (flow: Parameters<typeof prepareJudgeV2>[2]["flow"], instructions: typeof agentPrompt | null) =>
      prepareJudgeV2(normalizeCall(raw, {}), toCallRecord(raw), {
        scorecard: fallback,
        goal: seededGoal("caller"),
        weights: defaults(fallback),
        definitions: seededDefinitions(),
        instructions,
        flow,
        agentLabel: "Caller",
      }).call.messages[1]!.content;
    const vajra = user(
      {
        source: "vajra",
        conversation_id: 1,
        conversation_node_id: null,
        workflow_id: 2,
        workflow_version_id: 3,
        version: 25,
        required_fields: ["name_confirmed"],
        steps: [
          {
            step: "STEP_1",
            node_id: "a",
            type: "discuss",
            name: "Name confirmation",
            text: "Hi am I talking to {{first_name}}?",
            fields: [{ variable: "name_confirmed", data_type: "boolean", required: true, prompt: null }],
            next: [{ step: "STEP_2", when: "the caller says yes" }, { step: "END", when: null }],
          },
        ],
      },
      agentPrompt,
    );
    expect(vajra).toContain(
      "# Flow (Caller workflow v25; required steps and fields are marked)\n" +
        "STEP_1 (Name confirmation) [discuss]: Hi am I talking to {{first_name}}?\n" +
        "  Fields: name_confirmed (required)\n" +
        "  Next: STEP_2 when the caller says yes; END",
    );

    const none = user({ source: "prompt", text: null, reason: "no Vajra conversation on this call" }, null);
    expect(none).toContain("# Flow\nNot available (no Vajra conversation on this call).");
    expect(none).toContain("# Agent's instructions\nNot available for this call.");
  });

  it("judgedMetrics skips a missing weight as 0", () => {
    expect(judgedMetrics(hansa.metrics, { repetition: 100 }).map((m) => m.key)).toEqual(["repetition"]);
  });
});

/** A well-formed answer for the planted loop call, written by hand to exercise the validator. */
function answer(): JudgeOutputV2 {
  const ev = (turn: number, quote: string) => [{ turns: [turn], quote }];
  return {
    call_summary: "Screening call with a repeated question.",
    transcript_quality: { rating: "good", note: "" },
    system_checks: [
      { check: "S2", reason: "Repeated line.", evidence: [{ turns: [13, 15, 17], quote: "What is your notice period?" }], result: "FAIL" },
      { check: "S3", reason: "Steps reached.", evidence: [], result: "PASS" },
      { check: "S4", reason: "Matches.", evidence: [], result: "PASS" },
    ],
    business_goal: { reason: "Screened.", evidence: ev(18, "Thirty. Days."), outcome: "ACHIEVED", reason_code: "SCREENING_COMPLETED", required_outputs: [] },
    metrics: ["flow_adherence", "query_handling", "troubleshooting", "communication_tone", "opening_closure", "language_match", "repetition"].map(
      (key) => ({ key, reason: "ok", evidence: [], n_a: false, score: 10 }),
    ),
    failure_conditions: [{ code: "AGENT_LOOP", reason: "Loop.", evidence: [{ turns: [13, 15, 17], quote: "What is your notice period?" }] }],
    confidence: 0.9,
  };
}

describe("validateJudgeOutput (PRD §7)", () => {
  const { plan } = prepare();
  const transcript = normalizeCall(raw, {}).transcript;
  const errors = (output: unknown) => validateJudgeOutput(output, plan, transcript).errors;

  it("accepts a complete answer", () => {
    expect(errors(answer())).toEqual([]);
  });

  it("rejects a reply that isn't JSON, or isn't the schema's shape, with no usable output", () => {
    expect(validateJudgeOutput('{"call_summary": "cut off', plan, transcript)).toEqual({ output: null, errors: ["the response is not valid JSON"] });
    const r = validateJudgeOutput({ ...answer(), confidence: "high" }, plan, transcript);
    expect(r.output).toBeNull();
    expect(r.errors[0]).toContain("confidence");
  });

  it("rejects evidence citing turns the transcript doesn't have", () => {
    const a = answer();
    a.metrics[0]!.evidence = [{ turns: [999], quote: "x" }];
    a.business_goal.required_outputs = [];
    expect(errors(a)).toEqual([`evidence cites turn 999, which the transcript (turns 1–${transcript.length}) does not have`]);
  });

  it("rejects a deduction without evidence, a FAIL without evidence, and a missing or extra metric", () => {
    const a = answer();
    a.metrics[1]!.score = 6;
    a.system_checks[2] = { ...a.system_checks[2]!, result: "FAIL" };
    a.metrics.pop();
    a.metrics.push({ key: "stalling_filler", reason: "", evidence: [], n_a: false, score: 10 });
    expect(errors(a)).toEqual([
      "metrics is missing repetition",
      "metrics has stalling_filler, which was not asked for",
      "metric query_handling lost points without evidence",
      "check S4 is FAIL without evidence",
    ]);
  });

  it("allows an N/A metric with no evidence", () => {
    const a = answer();
    a.metrics[2] = { ...a.metrics[2]!, n_a: true, score: 0 };
    expect(errors(a)).toEqual([]);
  });

  it("rejects a reason code from another outcome's list, and an outcome that wasn't offered", () => {
    expect(errors({ ...answer(), business_goal: { ...answer().business_goal, reason_code: "WRONG_PERSON" } })).toEqual([
      "reason code WRONG_PERSON is not one of ACHIEVED's (SCREENING_COMPLETED, SLOT_CONFIRMED)",
    ]);
    expect(errors({ ...answer(), business_goal: { ...answer().business_goal, outcome: "PARTIAL" } })).toEqual([
      "business_goal outcome PARTIAL was not offered",
    ]);
  });

  it("does not reject a flag without evidence (applySeverity drops it)", () => {
    expect(errors({ ...answer(), failure_conditions: [{ code: "AGENT_LOOP", reason: "", evidence: [] }] })).toEqual([]);
  });

  it("the JSON schema's enums come from the plan", () => {
    const schema = judgeJsonSchemaV2(plan) as any;
    expect(schema.properties.metrics.items.properties.key.enum).toEqual(plan.metrics.map((m) => m.key));
    expect(schema.properties.failure_conditions.items.properties.code.enum).toEqual(plan.conditions.map((c) => c.code));
    expect(schema.properties.business_goal.properties.outcome.enum).toEqual(["ACHIEVED", "NOT_ACHIEVED", "NOT_APPLICABLE"]);
    // no required outputs on this call: a plain string, which the validator then rejects
    expect(schema.properties.business_goal.properties.required_outputs.items.properties.key).toEqual({ type: "string" });
  });
});

describe("judgePlan", () => {
  it("lists the enabled LLM conditions sorted by code", () => {
    const plan = judgePlan({ scorecard: hansa, weights: defaults(), goal: seededGoal("hrms"), definitions: seededDefinitions(), requiredOutputs: [] });
    const codes = plan.conditions.map((c) => c.code);
    expect(codes).toEqual([...codes].sort());
  });
});

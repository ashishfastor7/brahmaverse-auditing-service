import { describe, expect, it } from "bun:test";
import sample from "../../../fixtures/real/call-sample.json";
import vajra from "../../../fixtures/readers/vajra.json";
import { callRefs } from "./call-refs";
import { flowSteps, readCallerFlow, type FlowEdge, type FlowNode } from "./caller-flow";
import { fakeDb, sampleRow, throwingDb, vajraFixtureDb } from "./fake-db";

const version = vajra.workflow_versions[0];
const { steps, required_fields } = flowSteps(version.nodes as FlowNode[], version.edges as FlowEdge[]);
const stepNamed = (name: string) => steps.find((s) => s.step === name)!;

/** `### STEP_n` sections of call 4570's compiled flow, the prompt the agent actually got. */
const compiled = new Map(
  sample.config.variables.prompt
    .split(/^### /m)
    .slice(1)
    .map((section) => [section.split("\n")[0].trim(), section] as const),
);

describe("flowSteps", () => {
  it("names steps the way Vajra's compiler did on call 4570", () => {
    expect(steps.map((s) => [s.step, s.node_id])).toEqual([
      ["STEP_1", "discuss-name"],
      ["STEP_2", "say-sorry"],
      ["STEP_3", "discuss-intro"],
      ["STEP_4", "collect-ai"],
      ["STEP_5", "collect-callback"],
      ["STEP_6", "say-no-problem"],
      ["STEP_7", "say-perfect"],
      ["END", "end-1"],
    ]);
    // STEP_1..6 of the fixture graph are the same steps as in the real compiled prompt
    expect(compiled.get("STEP_1")).toContain("DO: Hi am I talking to");
    expect(compiled.get("STEP_2")).toContain(`SAY: "${stepNamed("STEP_2").text}"`);
    expect(compiled.get("STEP_3")).toContain("this is Rohan calling from <COMPANY>");
    expect(compiled.get("STEP_4")).toContain("ASK is_AI_used");
    expect(compiled.get("STEP_5")).toContain("ASK callback_preferred_datetime");
    expect(compiled.get("STEP_6")).toContain(`SAY: "${stepNamed("STEP_6").text}"`);
  });

  it("folds decisions into the step before them, with their conditions, in path order", () => {
    expect(stepNamed("STEP_1").next).toEqual([
      { step: "STEP_3", when: "{{name_confirmed}} is true/yes" },
      { step: "STEP_2", when: null },
    ]);
    expect(stepNamed("STEP_3").next.map((r) => r.step)).toEqual(["STEP_4", "STEP_6", "STEP_5", "END"]);
    expect(compiled.get("STEP_3")).toContain("4. OTHERWISE -> END");
    expect(stepNamed("STEP_2").next).toEqual([{ step: "END", when: null }]);
  });

  it("returns each step's fields and the required collect fields", () => {
    expect(stepNamed("STEP_5").fields).toEqual([
      {
        variable: "callback_preferred_datetime",
        data_type: "datetime",
        required: true,
        prompt: "No problem, when would be a better time to catch you?",
      },
      { variable: "questions", data_type: "text", required: false, prompt: "Anything you'd like us to prepare?" },
    ]);
    expect(stepNamed("STEP_1").fields.map((f) => f.variable)).toEqual(["name_confirmed"]);
    // name_confirmed is required but on a discuss step, so it isn't a required collect field
    expect(required_fields).toEqual(["is_AI_used", "callback_preferred_datetime"]);
  });

  it("only requires fields the call's finishConversation tool could save", () => {
    const finish = sample.tools.items.find((i) => i.name === "finishConversation")!;
    const saveable = Object.keys((finish as any).schema.properties.data.properties);
    expect(required_fields.every((f) => saveable.includes(f))).toBe(true);
  });

  it("names exits by closing message: EXIT for one, EXIT_n for several, END for none", () => {
    const end = (id: string, closing: string | null): FlowNode => ({ id, type: "end_conversation", data: { closing_message: closing } });
    const say: FlowNode = { id: "s", type: "say", data: { message: "hi" } };
    const edges = (...targets: string[]): FlowEdge[] => targets.map((t, i) => ({ id: `e${i}`, source: "s", target: t, order: i }));
    expect(flowSteps([say, end("a", "Bye!")], edges("a")).steps.map((s) => s.step)).toEqual(["STEP_1", "EXIT"]);
    const two = flowSteps([say, end("a", "Bye!"), end("b", "Thanks,\n bye")], edges("a", "b")).steps;
    expect(two.map((s) => [s.step, s.text])).toEqual([
      ["STEP_1", "hi"],
      ["EXIT_1", "Bye!"],
      ["EXIT_2", "Thanks,\n bye"],
    ]);
  });

  it("keeps nodes on a cycle, after the acyclic part, and ignores edges to unknown nodes", () => {
    const nodes: FlowNode[] = [
      { id: "a", type: "say", data: { message: "a" } },
      { id: "b", type: "discuss", data: { instructions: "b" } },
      { id: "c", type: "discuss", data: { instructions: "c" } },
    ];
    const edges: FlowEdge[] = [
      { id: "1", source: "b", target: "c" },
      { id: "2", source: "c", target: "b" },
      { id: "3", source: "a", target: "ghost" },
    ];
    expect(flowSteps(nodes, edges).steps.map((s) => [s.step, s.node_id, s.next.map((r) => r.step)])).toEqual([
      ["STEP_1", "a", []],
      ["STEP_2", "b", ["STEP_3"]],
      ["STEP_3", "c", ["STEP_2"]],
    ]);
  });

  it("joins nested decision conditions with AND, and drops paths with no edge or that loop back", () => {
    const nodes: FlowNode[] = [
      { id: "s", type: "say", data: { message: "hello" } },
      { id: "d1", type: "decision", data: { paths: [{ label: "A", condition: "x\n  is set" }, { label: "B" }] } },
      {
        id: "d2",
        type: "decision",
        data: {
          paths: [{ label: "C", condition: "y" }, { label: "D", condition: "z" }, { label: "no-edge", condition: "w" }, { label: "back" }],
        },
      },
      { id: "t1", type: "say", data: { message: "one" } },
      { id: "t2", type: "say", data: { message: "two" } },
      { id: "t3", type: "say", data: { message: "three" } },
    ];
    const edges: FlowEdge[] = [
      { id: "1", source: "s", target: "d1" },
      { id: "2", source: "d1", target: "d2", label: "A" },
      { id: "3", source: "d1", target: "t3", label: "B" },
      { id: "4", source: "d2", target: "t1", label: "C" },
      { id: "5", source: "d2", target: "t2", label: "D" },
      { id: "6", source: "d2", target: "d1", label: "back" },
    ];
    const { steps } = flowSteps(nodes, edges);
    expect(steps.map((s) => [s.step, s.node_id])).toEqual([
      ["STEP_1", "s"],
      ["STEP_2", "t1"],
      ["STEP_3", "t2"],
      ["STEP_4", "t3"],
    ]);
    expect(steps[0].next).toEqual([
      { step: "STEP_2", when: "x is set AND y" },
      { step: "STEP_3", when: "x is set AND z" },
      { step: "STEP_4", when: null },
    ]);
  });

  it("handles steps with no text, no data, an empty collect, and fields without a variable", () => {
    const nodes: FlowNode[] = [
      { id: "a", type: "discuss", data: { instructions: "", extract: [{ data_type: "text", required: true }, { variable: "v" }] } },
      { id: "b", type: "collect", data: { fields: [] } },
      { id: "c", type: "webhook", data: null },
    ];
    expect(flowSteps(nodes, []).steps.map(({ step, text, fields }) => ({ step, text, fields }))).toEqual([
      { step: "STEP_1", text: null, fields: [{ variable: "v", data_type: null, required: false, prompt: null }] },
      { step: "STEP_2", text: null, fields: [] },
      { step: "STEP_3", text: null, fields: [] },
    ]);
    expect(flowSteps([], [])).toEqual({ steps: [], required_fields: [] });
  });
});

describe("readCallerFlow", () => {
  it("follows conversation:2105 to the workflow version and returns its steps", async () => {
    const db = vajraFixtureDb();
    const flow = await readCallerFlow(callRefs(sampleRow()), null, db);
    expect(flow).toMatchObject({
      source: "vajra",
      conversation_id: 2105,
      conversation_node_id: "start-conv-1",
      workflow_id: 326,
      workflow_version_id: 902,
      version: 4,
      required_fields: ["is_AI_used", "callback_preferred_datetime"],
    });
    expect(flow.source === "vajra" && flow.steps).toEqual(steps);
    expect(db.sent.map((q) => q.params)).toEqual([[2105, 77], [711], [902]]);
  });

  const prompt = sample.config.variables.prompt;

  it("falls back to the prompt text for calls without a Vajra conversation (Hansa, Project manager)", async () => {
    const db = vajraFixtureDb();
    for (const system_ref_id of [null, "4570", "conversation:", "conversation:12x", "lead:5"]) {
      expect(await readCallerFlow(callRefs(sampleRow({ system_ref_id })), null, db)).toEqual({
        source: "prompt",
        text: prompt,
        reason: "no Vajra conversation on this call",
      });
    }
    expect(db.sent).toEqual([]);
  });

  it("uses the given instructions as the fallback text, else variables.prompt, else null", async () => {
    const hansa = sampleRow({ system_ref_id: null, data: { agent_code: "hansa", config: { variables: {} } } });
    expect(await readCallerFlow(callRefs(hansa), "You are Hansa.", null)).toMatchObject({ source: "prompt", text: "You are Hansa." });
    expect(await readCallerFlow(callRefs(hansa), null, null)).toMatchObject({ source: "prompt", text: null });
  });

  it("falls back with a reason when VAJRA_DB_* is missing, a row is missing, or the query fails", async () => {
    const refs = callRefs(sampleRow());
    expect(await readCallerFlow(refs, null, null)).toMatchObject({ source: "prompt", reason: "VAJRA_DB_* is not set" });
    expect(await readCallerFlow({ ...refs, business_id: 88 }, null, vajraFixtureDb())).toMatchObject({
      source: "prompt",
      reason: "no Vajra conversation 2105",
    });
    expect(await readCallerFlow({ ...refs, system_ref_id: "conversation:2200" }, null, vajraFixtureDb())).toMatchObject({
      reason: "conversation 2200 has no workflow execution",
    });
    const noVersion = fakeDb((table) =>
      table === "conversations" ? vajra.conversations : table === "workflow_executions" ? vajra.workflow_executions : [],
    );
    expect(await readCallerFlow(refs, null, noVersion)).toMatchObject({ reason: "no workflow version 902" });
    const noExecution = fakeDb((table) => (table === "conversations" ? vajra.conversations : []));
    expect(await readCallerFlow(refs, null, noExecution)).toMatchObject({ reason: "no workflow execution 711" });
    const emptyGraph = fakeDb((table, [id]) =>
      table === "conversations"
        ? vajra.conversations.filter((c) => c.id === id)
        : table === "workflow_executions"
          ? vajra.workflow_executions
          : [{ id, workflow_id: 326, version: 1, nodes: null, edges: null }],
    );
    expect(await readCallerFlow(refs, null, emptyGraph)).toMatchObject({ source: "vajra", steps: [], required_fields: [] });
    expect(await readCallerFlow(refs, null, throwingDb("timeout"))).toEqual({ source: "prompt", text: prompt, reason: "timeout" });
  });
});

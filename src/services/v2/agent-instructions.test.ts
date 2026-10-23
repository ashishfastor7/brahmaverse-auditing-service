import { describe, expect, it } from "bun:test";
import aiService from "../../../fixtures/readers/ai-service.json";
import { pickPrompt, readAgentInstructions, renderInstructions, type PromptRow } from "./agent-instructions";
import { callRefs } from "./call-refs";
import { aiFixtureDb, sampleRow, throwingDb } from "./fake-db";

const shared = aiService.prompts.find((p) => p.id === 12)! as PromptRow;
const override = aiService.prompts.find((p) => p.id === 40)! as PromptRow;

describe("pickPrompt", () => {
  it("prefers the business's own row over the shared one, whatever the order", () => {
    expect(pickPrompt([shared, override])?.id).toBe(40);
    expect(pickPrompt([override, shared])?.id).toBe(40);
  });

  it("falls back to the shared row, and to null when there is none", () => {
    expect(pickPrompt([shared])?.id).toBe(12);
    expect(pickPrompt([])).toBeNull();
  });

  it("breaks a tie between shared rows by lowest id", () => {
    expect(pickPrompt([{ ...shared, id: 30 }, shared])?.id).toBe(12);
  });
});

describe("renderInstructions", () => {
  const refs = callRefs(sampleRow());

  it("renders the prompt with call_type and the call variables", () => {
    const { system_prompt, prompt_id, prompt_code, version } = renderInstructions(shared, refs);
    expect({ prompt_id, prompt_code, version }).toEqual({ prompt_id: 12, prompt_code: "caller_base_prompt", version: 3 });
    expect(system_prompt).toStartWith(
      "You are Anjali, speaking with <CONTACT_NAME>. It is Monday, 12 October 2026, 5:39 PM.\nYou are calling them.",
    );
    // ai-service leaves a non-matching #if block in the text, so the agent got it too
    expect(system_prompt).toContain("You are calling them.{{#if call_type inbound}}They called you.{{/if}}");
    expect(system_prompt).toContain("### STEP_1");
    expect(system_prompt).toEndWith("Begin now at STEP_1.");
  });

  it("lets a call variable override call_type, as ai-service's spread does", () => {
    const inbound = { ...refs, call_type: "inbound" as const, variables: { ...refs.variables, call_type: "outbound" } };
    expect(renderInstructions(shared, inbound).system_prompt).toContain("You are calling them.");
  });

  it("swaps in the resume line on a resumed Ultravox call only", () => {
    const resumed = { ...refs, prior_call_id: "uv-123" };
    const ultravox = renderInstructions(shared, resumed).system_prompt;
    expect(ultravox).not.toContain("Begin now at STEP_1.");
    expect(ultravox).toEndWith("then carry on from where it stopped.");
    expect(renderInstructions(override, resumed).system_prompt).toEndWith("Begin now at STEP_1.");
    // no or unknown provider prefix runs on Ultravox, like ai-service's resolveVoiceProvider
    for (const model of ["gpt-realtime", "openai/gpt-realtime", null]) {
      expect(renderInstructions({ ...shared, model }, resumed).system_prompt).not.toContain("Begin now");
    }
    expect(renderInstructions(shared, refs).system_prompt).toEndWith("Begin now at STEP_1.");
  });
});

describe("readAgentInstructions", () => {
  it("reads the business override for business 77", async () => {
    const result = await readAgentInstructions(callRefs(sampleRow()), aiFixtureDb());
    expect(result.reason).toBeNull();
    expect(result.value?.prompt_id).toBe(40);
    expect(result.value?.system_prompt).toStartWith("You are Anjali for this business");
  });

  it("reads the shared row for a business without an override", async () => {
    const db = aiFixtureDb();
    const result = await readAgentInstructions(callRefs(sampleRow({ business_id: 88 })), db);
    expect(result.value?.prompt_id).toBe(12);
    expect(db.sent).toEqual([{ sql: expect.stringContaining("FROM prompts"), params: ["caller_base_prompt", "caller", 88] }]);
  });

  it("returns not_found when no row matches", async () => {
    const row = sampleRow({ data: { agent_code: "caller", config: { prompt_code: "nope", variables: {} } } });
    expect(await readAgentInstructions(callRefs(row), aiFixtureDb())).toMatchObject({ value: null, reason: "not_found" });
  });

  it("returns not_applicable without a prompt_code or agent_code, before touching the db", async () => {
    const db = aiFixtureDb();
    const result = await readAgentInstructions(callRefs(sampleRow({ data: { config: { prompt_code: "caller_base_prompt" } } })), db);
    expect(result).toMatchObject({ value: null, reason: "not_applicable" });
    expect(db.sent).toEqual([]);
  });

  it("returns not_configured without AI_DB_*", async () => {
    expect(await readAgentInstructions(callRefs(sampleRow()), null)).toMatchObject({ value: null, reason: "not_configured" });
  });

  it("turns a failed query into query_failed instead of throwing", async () => {
    expect(await readAgentInstructions(callRefs(sampleRow()), throwingDb("timeout"))).toEqual({
      value: null,
      reason: "query_failed",
      detail: "timeout",
    });
  });
});

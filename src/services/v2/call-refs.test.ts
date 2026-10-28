import { describe, expect, it } from "bun:test";
import sample from "../../../fixtures/call-sample.json";
import { callRefs } from "./call-refs";
import { sampleRow } from "./fake-db";

describe("callRefs", () => {
  it("reads call 4570's refs from a voice_call_logs row", () => {
    expect(callRefs(sampleRow())).toEqual({
      call_id: sample.id,
      business_id: 77,
      agent_code: "caller",
      prompt_code: "caller_base_prompt",
      call_type: "outbound",
      variables: sample.config.variables,
      system_ref_id: "conversation:2105",
      tools: sample.tools,
      prior_call_id: null,
    });
  });

  it("parses data stored as a JSON string, as some DB exports have it", () => {
    const row = sampleRow({
      data: JSON.stringify({ agent_code: "caller", config: { prompt_code: "p", prior_call_id: "uv-1" }, tools: { items: [] } }),
    });
    expect(callRefs(row)).toMatchObject({
      agent_code: "caller",
      prompt_code: "p",
      prior_call_id: "uv-1",
      tools: { items: [] },
      variables: {},
    });
  });

  it("keeps call_type to what ai-service accepts, and turns missing or empty values into null", () => {
    expect(callRefs(sampleRow({ call_type: "inbound" })).call_type).toBe("inbound");
    expect(callRefs(sampleRow({ call_type: null })).call_type).toBe("outbound");
    expect(callRefs({ id: "12", business_id: "5", system_ref_id: "", data: null })).toEqual({
      call_id: 12,
      business_id: 5,
      agent_code: null,
      prompt_code: null,
      call_type: "outbound",
      variables: {},
      system_ref_id: null,
      tools: null,
      prior_call_id: null,
    });
  });

  it("ignores variables or tools that aren't objects", () => {
    const refs = callRefs(sampleRow({ data: { config: { variables: "oops" }, tools: "{bad json" } }));
    expect(refs.variables).toEqual({});
    expect(refs.tools).toBeNull();
  });
});

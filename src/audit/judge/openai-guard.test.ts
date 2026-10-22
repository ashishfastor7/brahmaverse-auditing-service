import { describe, expect, it } from "bun:test";
import { createOpenAIJudge } from "./openai-judge";

describe("OpenAI guard (src/test-preload.ts)", () => {
  it("fails any test that creates the OpenAI client", () => {
    expect(() => createOpenAIJudge({ apiKey: "sk-test", model: "any" })).toThrow("OpenAI client created under bun test");
  });
});

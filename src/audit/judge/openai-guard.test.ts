import { describe, expect, it } from "bun:test";
import { createOpenAIJudge, parseJudgeContent } from "./openai-judge";

describe("OpenAI guard (src/test-preload.ts)", () => {
  it("fails any test that creates the OpenAI client", () => {
    expect(() => createOpenAIJudge({ apiKey: "sk-test", model: "any" })).toThrow("OpenAI client created under bun test");
  });
});

describe("parseJudgeContent", () => {
  it("parses JSON", () => {
    expect(parseJudgeContent('{"a":1}', false)).toEqual({ a: 1 });
  });

  it("v1 throws on a reply that isn't JSON, as before; v2 gets the raw text back so it can retry", () => {
    expect(() => parseJudgeContent('{"a":', false)).toThrow();
    expect(parseJudgeContent('{"a":', true)).toBe('{"a":');
  });
});

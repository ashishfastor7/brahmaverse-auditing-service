/**
 * Loaded before every `bun test` run (bunfig.toml). Unit tests never call the LLM: any test that creates the
 * OpenAI client fails here, whichever code path gets there. Use `fixtureJudge(name)` or a stub judge instead.
 */
import { mock } from "bun:test";

class BlockedOpenAI {
  constructor() {
    throw new Error("OpenAI client created under bun test: use fixtureJudge(name) or a stub judge");
  }
}

mock.module("openai", () => ({ default: BlockedOpenAI, OpenAI: BlockedOpenAI }));

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Judge, JudgeResponse } from "../audit-call";

/**
 * Recorded judge outputs, one JSON file per fixture. Written by `bun run record:fixture`, never by hand (v2's
 * malformed fixtures are the exception, and say so in `note`). v1 fixtures sit at the top level, v2 ones in `v2/`.
 */
export const JUDGE_FIXTURES_DIR = resolve(import.meta.dir, "../../../fixtures/judge");
export type Engine = "v1" | "v2";
export const fixturesDir = (engine: Engine = "v1") => (engine === "v1" ? JUDGE_FIXTURES_DIR : join(JUDGE_FIXTURES_DIR, "v2"));

export type JudgeFixture = {
  name: string;
  /** The planted case (fixtures/planted/cases.ts) the judge graded. */
  case: string;
  /** v1: the rubric version. v2: the scorecard, as `<id>@<version>`. */
  rubric_version: string;
  judge_model: string;
  recorded_at: string;
  /** v2 only: the `JUDGE_PROMPT_VERSION` the response answered. */
  judge_prompt_version?: string;
  /** Set on hand-made fixtures: what was changed, and from which recording. */
  note?: string;
  /** Exactly what the real judge returned. */
  response: JudgeResponse;
};

const NAME = /^[a-z0-9-]+$/;

export const listJudgeFixtures = (engine: Engine = "v1") => {
  const dir = fixturesDir(engine);
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.slice(0, -".json".length))
        .sort()
    : [];
};

export function loadJudgeFixture(name: string, engine: Engine = "v1"): JudgeFixture {
  const file = join(fixturesDir(engine), `${name}.json`);
  if (!NAME.test(name) || !existsSync(file)) {
    const dir = engine === "v1" ? "fixtures/judge/" : "fixtures/judge/v2/";
    throw new Error(`no judge fixture "${name}" in ${dir} (have: ${listJudgeFixtures(engine).join(", ") || "none"})`);
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

/** A judge that replays a recorded response, for tests: same `Judge` type as the OpenAI one, no network. */
export function fixtureJudge(name: string, engine: Engine = "v1"): Judge {
  const { response } = loadJudgeFixture(name, engine);
  return async () => structuredClone(response);
}

/**
 * Replays one recorded response per call, in order (e.g. a malformed answer, then the good one after the retry), and
 * records each request so tests can check what was asked. Throws when asked more often than it has responses.
 */
export function fixtureJudgeSequence(names: string[], engine: Engine = "v2"): Judge & { calls: Parameters<Judge>[0][] } {
  const responses = names.map((n) => loadJudgeFixture(n, engine).response);
  const calls: Parameters<Judge>[0][] = [];
  const judge = async (call: Parameters<Judge>[0]) => {
    calls.push(call);
    const next = responses[calls.length - 1];
    if (!next) throw new Error(`fixture judge asked ${calls.length} times, has ${responses.length} responses`);
    return structuredClone(next);
  };
  return Object.assign(judge, { calls });
}

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Judge, JudgeResponse } from "../audit-call";

/** Recorded judge outputs, one JSON file per fixture. Written by `bun run record:fixture`, never by hand. */
export const JUDGE_FIXTURES_DIR = resolve(import.meta.dir, "../../../fixtures/judge");

export type JudgeFixture = {
  name: string;
  /** The planted case (fixtures/planted/cases.ts) the judge graded. */
  case: string;
  rubric_version: string;
  judge_model: string;
  recorded_at: string;
  /** Exactly what the real judge returned. */
  response: JudgeResponse;
};

const NAME = /^[a-z0-9-]+$/;

export const listJudgeFixtures = () =>
  existsSync(JUDGE_FIXTURES_DIR)
    ? readdirSync(JUDGE_FIXTURES_DIR)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.slice(0, -".json".length))
        .sort()
    : [];

export function loadJudgeFixture(name: string): JudgeFixture {
  const file = join(JUDGE_FIXTURES_DIR, `${name}.json`);
  if (!NAME.test(name) || !existsSync(file)) {
    throw new Error(`no judge fixture "${name}" in fixtures/judge/ (have: ${listJudgeFixtures().join(", ") || "none"})`);
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

/** A judge that replays a recorded response, for tests: same `Judge` type as the OpenAI one, no network. */
export function fixtureJudge(name: string): Judge {
  const { response } = loadJudgeFixture(name);
  return async () => structuredClone(response);
}

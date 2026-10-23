import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readAgentInstructions } from "./agent-instructions";
import { callRefs } from "./call-refs";
import { readCallerFlow } from "./caller-flow";
import { kbScope, readKnowledgeBase } from "./knowledge-base";
import { replayDb, type RecordedFixture } from "./recorded-fixture";
import type { ReadOnlyDb } from "@/services/readonly-db";

/**
 * The readers on real rows: every call recorded with `bun run record:readers` in fixtures/readers/recorded/. These
 * check what hand-built rows can't: that the real tables have the columns and shapes the readers expect, and that
 * what they return agrees with what the call itself shows (its compiled flow, its tools, its variables).
 */
const DIR = join(import.meta.dir, "../../../fixtures/readers/recorded");
const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith(".json")) : [];

/** Replays, and counts which recorded queries were asked for, so a stale recording shows up. */
function counted(fixture: RecordedFixture, name: "ai" | "vajra", used: Set<string>): ReadOnlyDb {
  const db = replayDb(fixture, name);
  return {
    async query(sql, params = []) {
      used.add(`${name} ${sql} ${JSON.stringify(params)}`);
      return db.query(sql, params);
    },
  };
}

/** `### STEP_n` sections of a compiled Vajra flow prompt. */
const sections = (prompt: string) =>
  new Map(
    prompt
      .split(/^### /m)
      .slice(1)
      .map((s) => [s.split("\n")[0].trim(), s] as const),
  );

describe("readers on recorded real rows", () => {
  if (!files.length) it.skip("no recorded calls yet: run `bun run record:readers --call-id <id>`", () => {});

  for (const file of files) {
    const fixture: RecordedFixture = JSON.parse(readFileSync(join(DIR, file), "utf8"));
    const refs = callRefs(fixture.row);

    describe(file, () => {
      it("replays every recorded query and nothing else", async () => {
        const used = new Set<string>();
        await readAgentInstructions(refs, counted(fixture, "ai", used));
        await readKnowledgeBase(refs, counted(fixture, "ai", used));
        await readCallerFlow(refs, null, counted(fixture, "vajra", used));
        expect([...used].sort()).toEqual(fixture.queries.map((q) => `${q.db} ${q.sql} ${JSON.stringify(q.params)}`).sort());
      });

      it("finds the agent's instructions and renders every call variable into them", async () => {
        const result = await readAgentInstructions(refs, replayDb(fixture, "ai"));
        expect(result.reason).toBeNull();
        const prompt = result.value!.system_prompt;
        expect(result.value!.prompt_code).toBe(refs.prompt_code!);
        for (const key of Object.keys(refs.variables)) expect(prompt).not.toContain(`{{${key}}}`);
        if (typeof refs.variables.prompt === "string") expect(prompt).toContain(refs.variables.prompt.slice(0, 200));
      });

      it("reads only knowledge base documents in the call's scope, for its agent", async () => {
        const result = await readKnowledgeBase(refs, replayDb(fixture, "ai"));
        const scope = kbScope(refs.tools);
        if (scope.kind === "none") return void expect(result.reason).toBe("not_applicable");
        expect(result.reason).toBeNull();
        for (const doc of result.value!.documents) {
          expect(doc.agent_code).toBe(refs.agent_code!);
          if (scope.kind === "ids") expect(scope.ids).toContain(Number(doc.id));
          if (scope.kind === "group") expect(scope.groups).toContain(doc.document_group!);
        }
      });

      it("reads the Vajra flow for a Caller call, matching the STEP_n prompt the agent got", async () => {
        const flow = await readCallerFlow(refs, null, replayDb(fixture, "vajra"));
        if (!refs.system_ref_id?.startsWith("conversation:")) return void expect(flow.source).toBe("prompt");
        expect(flow.source).toBe("vajra");
        if (flow.source !== "vajra") return;

        const compiled = sections(String(refs.variables.prompt ?? ""));
        const named = flow.steps.map((s) => s.step).filter((s) => s !== "END");
        expect(named).toEqual([...compiled.keys()].filter((s) => s !== "END" && s !== "HANGUP"));
        for (const step of flow.steps.filter((s) => s.type === "collect")) {
          for (const field of step.fields) expect(compiled.get(step.step)).toContain(field.variable);
        }
        const finish = refs.tools?.items?.find((i) => i.name === "finishConversation") as any;
        const saveable = Object.keys(finish?.schema?.properties?.data?.properties ?? {});
        if (saveable.length) for (const field of flow.required_fields) expect(saveable).toContain(field);
      });
    });
  }
});

import { conditionsRouter } from "@/routes/conditions";
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { QueryTypes, type Sequelize } from "sequelize";
import { ZodError } from "zod";
import { addCondition, deleteCondition, discardDraft, listConditions, publishDraft } from "./condition-store";
import { createScorecardDraft, loadActiveConfig } from "./config-store";
import { createMigrator } from "./migrator";
import { dbTestsEnabled, withTestDb } from "./test-db";
import type { AuthEnv } from "@/middleware/auth";

/** The routers read the signed-in user that the app's session middleware sets; here it's always "admin". */
const signedIn = () =>
  new Hono<AuthEnv>().use(async (c, next) => {
    c.set("username", "admin");
    await next();
  });

const all = <T extends object>(sequelize: Sequelize, sql: string) => sequelize.query<T>(sql, { type: QueryTypes.SELECT });
/** The error message, or null if it worked. (Bun 1.2's `expect(...).rejects` hangs on Sequelize errors.) */
const failure = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: Error) => e.message,
  );

const OTP = {
  label: "Asked for the OTP",
  flags_when: "The agent asked the other party to read out a one-time password",
  does_not_count: "the other party offered it without being asked",
  severity: "critical" as const,
  scorecards: ["default", "hansa"],
};

describe.skipIf(!dbTestsEnabled)("failure-condition screen (condition-store, /conditions)", () => {
  it("lists the library and the 10-metric scorecards, without the v1 templates", () =>
    withTestDb(async (sequelize) => {
      await createMigrator(sequelize, { quiet: true }).up();
      const { conditions, scorecards } = await listConditions(sequelize);
      expect(conditions).toHaveLength(20);
      expect(scorecards.map((s) => [s.scorecard_id, s.published, s.draft, s.agents, s.metrics.length, s.pending])).toEqual([
        ["default", 4, null, ["caller", "project-manager"], 10, []],
        ["hansa", 4, null, ["hrms"], 10, []],
      ]);
    }));

  it("adding puts it in the library and the drafts; it counts only once a draft is published", () =>
    withTestDb(async (sequelize) => {
      await createMigrator(sequelize, { quiet: true }).up();
      const added = await addCondition(sequelize, OTP, "admin");
      expect(added).toMatchObject({
        code: "ASKED_FOR_THE_OTP",
        definition:
          "The agent asked the other party to read out a one-time password. It does NOT count when the other party offered it without being asked.",
        default_severity: "critical",
        rolls_up_to: [],
        detection: "llm",
      });

      const pending = { condition_code: "ASKED_FOR_THE_OTP", enabled: true, severity: "critical" as const, metric_key: null };
      const listed = await listConditions(sequelize);
      expect(listed.scorecards.map((s) => [s.scorecard_id, s.draft, s.pending])).toEqual([
        ["default", 5, [pending]],
        ["hansa", 5, [pending]],
      ]);
      // Not live yet: the agents are still on v4.
      expect((await loadActiveConfig(sequelize, "caller", null)).scorecard?.version).toBe(4);

      // A second one joins the same draft; a Major one zeroes the metric it names.
      await addCondition(
        sequelize,
        { ...OTP, label: "Read out a card number", severity: "major", metric_key: "query_handling", scorecards: ["default"] },
        "admin",
      );
      const [card] = await all<{ rolls_up_to: string[] }>(sequelize, "SELECT rolls_up_to FROM failure_condition WHERE code = 'READ_OUT_A_CARD_NUMBER'");
      expect(card!.rolls_up_to).toEqual(["Query handling"]);
      expect((await listConditions(sequelize)).scorecards[0]!.pending).toEqual([
        pending,
        { condition_code: "READ_OUT_A_CARD_NUMBER", enabled: true, severity: "major", metric_key: "query_handling" },
      ]);

      const published = await publishDraft(sequelize, "default", "admin");
      expect(published.version).toBe(5);
      const caller = (await loadActiveConfig(sequelize, "caller", null)).scorecard!;
      expect(caller.version).toBe(5);
      expect(caller.conditions.map((c) => c.condition_code)).toContain("READ_OUT_A_CARD_NUMBER");
      expect((await loadActiveConfig(sequelize, "hrms", null)).scorecard?.version).toBe(4);

      // Published: it can't be removed. Hansa's draft can still be thrown away.
      expect(await failure(deleteCondition(sequelize, "ASKED_FOR_THE_OTP"))).toContain("used by published default v5");
      await discardDraft(sequelize, "hansa");
      expect((await listConditions(sequelize)).scorecards[1]).toMatchObject({ draft: null, pending: [] });
      expect(await failure(discardDraft(sequelize, "hansa"))).toContain("has no draft to discard");
      expect(await failure(publishDraft(sequelize, "hansa", "admin"))).toContain("has no draft to publish");
    }));

  it("an unpublished condition can be removed, from the library and the drafts", () =>
    withTestDb(async (sequelize) => {
      await createMigrator(sequelize, { quiet: true }).up();
      await addCondition(sequelize, OTP, "admin");
      await deleteCondition(sequelize, "ASKED_FOR_THE_OTP");
      const { conditions, scorecards } = await listConditions(sequelize);
      expect(conditions.map((c) => c.code)).not.toContain("ASKED_FOR_THE_OTP");
      expect(scorecards.map((s) => s.pending)).toEqual([[], []]);
      expect(await failure(deleteCondition(sequelize, "AGENT_LOOP"))).toContain("used by published");
      expect(await failure(deleteCondition(sequelize, "NOPE"))).toContain("no condition NOPE");
    }));

  it("refuses bad input and changes nothing", () =>
    withTestDb(async (sequelize) => {
      await createMigrator(sequelize, { quiet: true }).up();
      const refused = (over: object) => failure(addCondition(sequelize, { ...OTP, ...over }, "admin"));
      expect(await refused({ code: "AGENT_LOOP" })).toContain("already exists");
      expect(await refused({ code: "1x" })).toContain("must be 3–64 capital letters");
      expect(await refused({ severity: "major" })).toContain("needs the metric it sets to 0");
      expect(await refused({ metric_key: "made_up" })).toContain("has no metric made_up");
      expect(await refused({ scorecards: [] })).toContain("pick at least one scorecard");
      expect(await refused({ scorecards: ["default", "nope"] })).toContain("unknown scorecard nope");
      // The failed attempts left no draft and no library row behind.
      const { conditions, scorecards } = await listConditions(sequelize);
      expect([conditions.length, scorecards.map((s) => s.draft)]).toEqual([20, [null, null]]);
    }));

  it("pending lists a condition the draft changes, not only ones it adds", () =>
    withTestDb(async (sequelize) => {
      await createMigrator(sequelize, { quiet: true }).up();
      await createScorecardDraft(sequelize, "default", "admin");
      await sequelize.query(
        "UPDATE scorecard_condition SET severity = 'major' WHERE scorecard_id = 'default' AND scorecard_version = 5 AND condition_code = 'WRONG_LANGUAGE'",
      );
      expect((await listConditions(sequelize)).scorecards[0]!.pending).toEqual([
        { condition_code: "WRONG_LANGUAGE", enabled: true, severity: "major", metric_key: "language_match" },
      ]);
    }));

  it("refuses a draft with fewer than 10 metrics", () =>
    withTestDb(async (sequelize) => {
      await createMigrator(sequelize, { quiet: true }).up();
      await createScorecardDraft(sequelize, "default", "admin");
      await sequelize.query("DELETE FROM metric WHERE scorecard_id = 'default' AND scorecard_version = 5 AND key = 'repetition'");
      expect(await failure(addCondition(sequelize, OTP, "admin"))).toContain("scorecard default has fewer than 10 metrics");
    }));

  it("routes: 404 while v2 is off; 201, 400, 404 and 409 otherwise", () =>
    withTestDb(async (sequelize) => {
      await createMigrator(sequelize, { quiet: true }).up();
      let v2 = false;
      const app = signedIn().route(
        "/v1/audit",
        conditionsRouter(
          () => sequelize,
          () => v2,
        ),
      );
      // As in app.ts.
      app.onError((err, c) =>
        c.json({ message: err.message }, err instanceof HTTPException ? err.status : err instanceof ZodError ? 400 : 500),
      );
      const send = async (method: string, path: string, body?: unknown) => {
        const res = await app.request(`/v1/audit${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, body: (await res.json()) as any };
      };

      expect((await send("GET", "/conditions")).status).toBe(404);
      expect((await send("POST", "/conditions", OTP)).status).toBe(404);
      expect((await send("POST", "/scorecards/default/publish")).status).toBe(404);

      v2 = true;
      expect((await send("GET", "/conditions")).body.data.conditions).toHaveLength(20);
      const created = await send("POST", "/conditions", OTP);
      expect([created.status, created.body.data.code]).toEqual([201, "ASKED_FOR_THE_OTP"]);
      expect((await send("POST", "/conditions", OTP)).status).toBe(409);
      expect((await send("POST", "/conditions", { ...OTP, label: "" })).status).toBe(400);
      expect((await send("POST", "/conditions", { ...OTP, code: "NEW_ONE", scorecards: ["nope"] })).status).toBe(404);
      const published = await send("POST", "/scorecards/default/publish");
      expect([published.status, published.body.data.version]).toEqual([200, 5]);
      expect((await send("POST", "/scorecards/default/publish")).status).toBe(404);
      expect((await send("DELETE", "/conditions/ASKED_FOR_THE_OTP")).status).toBe(409);
      expect((await send("DELETE", "/scorecards/hansa/draft")).status).toBe(200);
    }));
});

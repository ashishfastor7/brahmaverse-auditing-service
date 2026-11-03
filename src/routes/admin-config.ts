import { GOAL_TEMPLATES } from "@/audit/v2/goal-templates";
import {
  ConfigError,
  discardGoalDraft,
  goalHistory,
  listAdminScorecards,
  listGoals,
  loadGoalAdmin,
  loadScorecardAdmin,
  publishGoal,
  scorecardHistory,
  simulateDraft,
  startGoalDraft,
  startScorecardDraft,
  updateGoalDraft,
  updateScorecardDraft,
} from "@/db/config-admin";
import { type AuthEnv, signedInUser } from "@/middleware/auth";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Sequelize } from "sequelize";
import { z } from "zod";

const text = z.string().max(4000);
const list = z.array(z.string().max(1000)).max(50);

// Loose, so a field that can't be edited (method, scale, …) reaches `applyScorecardEdit` and gets its own message.
const metricPatch = z.looseObject({
  key: z.string(),
  name: z.string().max(120).optional(),
  description: text.optional(),
  rubric: z.object({ checks: text.optional(), anchors: z.record(z.string(), text).optional() }).optional(),
  applicability: text.optional(),
  auto_fail: z.boolean().optional(),
  weight: z.number().min(0).max(100).optional(),
});
const scorecardPatch = z.strictObject({
  pass_threshold: z.number().optional(),
  metrics: z.array(metricPatch).max(20).optional(),
  conditions: z
    .array(
      z.strictObject({
        code: z.string(),
        enabled: z.boolean().optional(),
        severity: z.enum(["critical", "major", "minor"]).optional(),
        metric_key: z.string().nullable().optional(),
      }),
    )
    .max(100)
    .optional(),
});
const goalPatch = z.strictObject({
  name: z.string().max(120).optional(),
  description: text.optional(),
  success_criteria: list.optional(),
  partial_success: list.optional(),
  not_applicable_when: list.optional(),
  required_outputs: list.optional(),
  reason_codes: z.record(z.string(), list).optional(),
  // No silence limit: S2 has no timing data to apply it to yet.
  system_checks: z.strictObject({ required_variables: list.optional(), flow_steps: list.nullable().optional() }).optional(),
});
const goalDraft = z.object({ template: z.string().optional() });

/**
 * P1-18 / P1-20: the scorecard and goal admin screens. 404 while v2 is off. Every write records `signedInUser(c)` in
 * the change log. Publishing and discarding a scorecard draft are `POST /scorecards/:id/publish` and
 * `DELETE /scorecards/:id/draft` in `conditions.ts`, shared with the failure-condition screen.
 * - Scorecards: `GET /scorecards`, `GET /scorecards/:id`, `POST /scorecards/:id/draft`, `PATCH /scorecards/:id/draft`,
 *   `GET /scorecards/:id/simulation?n=100`, `GET /scorecards/:id/history`.
 * - Goals: `GET /goal-templates`, `GET /goals`, `GET /goals/:agent`, `POST /goals/:agent/draft` (`{ template? }`),
 *   `PATCH /goals/:agent/draft`, `POST /goals/:agent/publish`, `DELETE /goals/:agent/draft`, `GET /goals/:agent/history`.
 * Takes the database and the flag so tests can pass their own.
 */
export function adminConfigRouter(db: () => Sequelize, v2Enabled: () => boolean) {
  const router = new Hono<AuthEnv>();
  const guard = <T>(work: () => Promise<T>) => {
    if (!v2Enabled()) throw new HTTPException(404, { message: "Not found" });
    return work().catch((e) => {
      throw e instanceof ConfigError ? new HTTPException(e.status, { message: e.message }) : e;
    });
  };
  const body = (c: { req: { json: () => Promise<unknown> } }) => c.req.json().catch(() => ({}));

  router.get("/scorecards", async (c) => c.json({ data: await guard(() => listAdminScorecards(db())) }));
  router.get("/scorecards/:id", async (c) => c.json({ data: await guard(() => loadScorecardAdmin(db(), c.req.param("id"))) }));
  router.post("/scorecards/:id/draft", async (c) =>
    c.json({ data: await guard(() => startScorecardDraft(db(), c.req.param("id"), signedInUser(c))) }, 201),
  );
  router.patch("/scorecards/:id/draft", async (c) =>
    c.json({ data: await guard(async () => updateScorecardDraft(db(), c.req.param("id"), scorecardPatch.parse(await body(c)), signedInUser(c))) }),
  );
  router.get("/scorecards/:id/simulation", async (c) =>
    c.json({ data: await guard(() => simulateDraft(db(), c.req.param("id"), Number(c.req.query("n") ?? 100))) }),
  );
  router.get("/scorecards/:id/history", async (c) => c.json({ data: await guard(() => scorecardHistory(db(), c.req.param("id"))) }));

  router.get("/goal-templates", async (c) => c.json({ data: await guard(async () => GOAL_TEMPLATES) }));
  router.get("/goals", async (c) => c.json({ data: await guard(() => listGoals(db())) }));
  router.get("/goals/:agent", async (c) => c.json({ data: await guard(() => loadGoalAdmin(db(), c.req.param("agent"))) }));
  router.post("/goals/:agent/draft", async (c) => {
    const data = await guard(async () => startGoalDraft(db(), c.req.param("agent"), signedInUser(c), goalDraft.parse(await body(c)).template));
    return c.json({ data }, 201);
  });
  router.patch("/goals/:agent/draft", async (c) =>
    c.json({ data: await guard(async () => updateGoalDraft(db(), c.req.param("agent"), goalPatch.parse(await body(c)), signedInUser(c))) }),
  );
  router.post("/goals/:agent/publish", async (c) => c.json({ data: await guard(() => publishGoal(db(), c.req.param("agent"), signedInUser(c))) }));
  router.delete("/goals/:agent/draft", async (c) => {
    await guard(() => discardGoalDraft(db(), c.req.param("agent"), signedInUser(c)));
    return c.json({ data: null });
  });
  router.get("/goals/:agent/history", async (c) => c.json({ data: await guard(() => goalHistory(db(), c.req.param("agent"))) }));
  return router;
}

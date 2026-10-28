import { ConditionError, addCondition, deleteCondition, discardDraft, listConditions, publishDraft } from "@/db/condition-store";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Sequelize } from "sequelize";
import { z } from "zod";

/** The shared login (P1-17 replaces the bearer token with it); drafts and published versions record it. */
const SHARED_LOGIN = "admin";

const newCondition = z.object({
  code: z.string().max(64).optional(),
  label: z.string().trim().min(3).max(120),
  flags_when: z.string().trim().min(10).max(1000),
  does_not_count: z.string().trim().min(3).max(500),
  severity: z.enum(["critical", "major", "minor"]),
  metric_key: z.string().nullish(),
  scorecards: z.array(z.string()).min(1),
});

/**
 * PRD §4.5 failure-condition screen. 404 while v2 is off.
 * - `GET /conditions`: the library and each scorecard's conditions, with what its draft would change.
 * - `POST /conditions`: adds a condition to the library and to the drafts of the scorecards given; nothing is published.
 * - `DELETE /conditions/:code`: only for a condition no published scorecard uses.
 * - `POST /scorecards/:id/publish`, `DELETE /scorecards/:id/draft`: publish or throw away a scorecard's draft.
 * Takes the database and the flag so tests can pass their own.
 */
export function conditionsRouter(db: () => Sequelize, v2Enabled: () => boolean) {
  const router = new Hono();
  const guard = <T>(work: () => Promise<T>) => {
    if (!v2Enabled()) throw new HTTPException(404, { message: "Not found" });
    return work().catch((e) => {
      throw e instanceof ConditionError ? new HTTPException(e.status, { message: e.message }) : e;
    });
  };

  router.get("/conditions", async (c) => c.json({ data: await guard(() => listConditions(db())) }));
  router.post("/conditions", async (c) => {
    const data = await guard(async () => addCondition(db(), newCondition.parse(await c.req.json().catch(() => ({}))), SHARED_LOGIN));
    return c.json({ data }, 201);
  });
  router.delete("/conditions/:code", async (c) => {
    await guard(() => deleteCondition(db(), c.req.param("code")));
    return c.json({ data: null });
  });
  router.post("/scorecards/:id/publish", async (c) => c.json({ data: await guard(() => publishDraft(db(), c.req.param("id"), SHARED_LOGIN)) }));
  router.delete("/scorecards/:id/draft", async (c) => {
    await guard(() => discardDraft(db(), c.req.param("id")));
    return c.json({ data: null });
  });
  return router;
}

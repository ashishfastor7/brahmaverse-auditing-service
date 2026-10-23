import { WeightsError, saveRescore } from "@/db/rescore";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Sequelize } from "sequelize";
import { z } from "zod";

/** The shared login (P1-17 replaces the bearer token with it); re-scores record it as `created_by`. */
const SHARED_LOGIN = "admin";

const body = z.object({ weights: z.record(z.string(), z.number()) });

/**
 * P1-9: `POST /audits/:id/rescore` with `{ weights }` re-scores a v2 audit from its stored metric results (no judge
 * call) and adds it to the audit's re-score history. 404 while v2 is off, and for a missing or v1 audit; 400 for
 * weights that don't fit the audit's scorecard. Takes the database and the flag so tests can pass their own.
 */
export function rescoreRouter(db: () => Sequelize, v2Enabled: () => boolean) {
  const router = new Hono();
  router.post("/audits/:id/rescore", async (c) => {
    const id = Number(c.req.param("id"));
    if (!v2Enabled() || !Number.isInteger(id)) throw new HTTPException(404, { message: "Audit not found" });
    const { weights } = body.parse(await c.req.json().catch(() => ({})));
    const rescore = await saveRescore(db(), id, weights, SHARED_LOGIN).catch((e) => {
      throw e instanceof WeightsError ? new HTTPException(400, { message: e.message }) : e;
    });
    if (!rescore) throw new HTTPException(404, { message: "Audit not found" });
    return c.json({ data: rescore });
  });
  return router;
}

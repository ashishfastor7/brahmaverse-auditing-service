import { validateReview } from "@/audit/v2/review";
import { currentAuditId, insertReview, loadAuditView, reviewTarget } from "@/db/audit-view";
import { type AuthEnv, signedInUser } from "@/middleware/auth";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Sequelize } from "sequelize";
import { z } from "zod";

const OUTCOMES = ["ACHIEVED", "PARTIAL", "NOT_ACHIEVED", "NOT_APPLICABLE"] as const;
const CHECK_RESULTS = ["PASS", "FAIL", "NOT_APPLICABLE"] as const;

const reviewBody = z.object({
  verdict: z.enum(["agree", "dispute", "flag"]),
  corrected_scores: z.record(z.string(), z.number().nullable()).optional(),
  corrected_checks: z.record(z.string(), z.enum(CHECK_RESULTS)).optional(),
  expected_business_outcome: z.enum(OUTCOMES).nullable().optional(),
  expected_failure_codes: z.array(z.string()).nullable().optional(),
  item_notes: z.record(z.string(), z.string().trim().min(1).max(2000)).optional(),
  note: z.string().max(4000).nullable().optional(),
});

const id = (raw: string) => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * The v2 call page's API (PRD §5; P2-1, P2-3, P2-4). 404 for everything while v2 is off.
 * - `GET /v2/calls/:id/audit`: the call's current v2 audit (`currentAuditId`) with its rubrics, condition definitions,
 *   history and reviews; `{ data: null }` when the call has none. The call itself comes from `GET /calls/:id`.
 * - `GET /v2/audits/:id`: the same for any v2 audit, e.g. an older one opened from the history (read-only).
 * - `POST /v2/audits/:id/reviews`: agree, dispute (several items, each with a note) or flag, saved with
 *   `kind = 'normal'` and the signed-in user. 400 when `validateReview` refuses it, 409 for an audit that isn't completed.
 */
export function callV2Router(db: () => Sequelize, v2Enabled: () => boolean) {
  const router = new Hono<AuthEnv>();
  router.use("/v2/calls/*", async (_c, next) => {
    if (!v2Enabled()) throw new HTTPException(404, { message: "Not found" });
    await next();
  });
  router.use("/v2/audits/*", async (_c, next) => {
    if (!v2Enabled()) throw new HTTPException(404, { message: "Not found" });
    await next();
  });

  router.get("/v2/calls/:id/audit", async (c) => {
    const callId = id(c.req.param("id"));
    if (!callId) throw new HTTPException(404, { message: "Call not found" });
    const auditId = await currentAuditId(db(), "voice_call_logs", callId);
    return c.json({ data: auditId === null ? null : await loadAuditView(db(), auditId) });
  });

  router.get("/v2/audits/:id", async (c) => {
    const auditId = id(c.req.param("id"));
    const view = auditId && (await loadAuditView(db(), auditId));
    if (!view) throw new HTTPException(404, { message: "Audit not found" });
    return c.json({ data: view });
  });

  router.post("/v2/audits/:id/reviews", async (c) => {
    const auditId = id(c.req.param("id"));
    const view = auditId && (await loadAuditView(db(), auditId));
    if (!view) throw new HTTPException(404, { message: "Audit not found" });
    const target = reviewTarget(view.audit, view.context);
    if (!target) throw new HTTPException(409, { message: `This audit is ${view.audit.status}; only completed audits can be reviewed` });
    const input = reviewBody.parse(await c.req.json().catch(() => ({})));
    const errors = validateReview(input, target);
    if (errors.length) throw new HTTPException(400, { message: errors.join("; ") });
    const review = await insertReview(db(), view.audit.id, signedInUser(c), "normal", input);
    return c.json({ data: review }, 201);
  });

  return router;
}

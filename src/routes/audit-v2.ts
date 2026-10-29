import { AuditRequestError, type RunOptionsV2, runAuditV2 } from "@/audit/v2/run-audit";
import { getSourceCall } from "@/services/call-source.db";
import { type AuthEnv, signedInUser } from "@/middleware/auth";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Sequelize } from "sequelize";
import { z } from "zod";

const body = z.object({ weights: z.record(z.string(), z.number()).optional() });

/**
 * `POST /v2/calls/:id/audit` with an optional `{ weights }` (the sliders; default: the scorecard's) audits one call
 * with the v2 engine now (*Audit this call*, PRD §7) and returns the new audit. Always a fresh judge run; the previous
 * v2 audit of the call is superseded. 404 while v2 is off or for an unknown call, 400 for weights it can't use, 502
 * when the judge fails. The v1 route is unchanged, so both engines can audit the same call side by side (PRD §9).
 * Takes the database, the flag, the call reader and the judge (default: the pinned one) so tests can pass their own.
 */
export function auditV2Router(
  db: () => Sequelize,
  v2Enabled: () => boolean,
  readCall: (id: number) => Promise<any | null> = getSourceCall,
  judge?: RunOptionsV2["judge"],
) {
  const router = new Hono<AuthEnv>();
  router.post("/v2/calls/:id/audit", async (c) => {
    const id = Number(c.req.param("id"));
    if (!v2Enabled() || !Number.isInteger(id)) throw new HTTPException(404, { message: "Call not found" });
    const { weights } = body.parse(await c.req.json().catch(() => ({})));
    const raw = await readCall(id);
    if (!raw) throw new HTTPException(404, { message: "Call not found" });
    const options: RunOptionsV2 = { weights, force: true, judge, triggeredBy: signedInUser(c), triggerMode: "single" };
    const row = await runAuditV2(db(), raw, options).catch((e) => {
      if (e instanceof AuditRequestError) throw new HTTPException(400, { message: e.message });
      throw new HTTPException(502, { message: `Audit failed: ${(e as Error).message}` });
    });
    return c.json({ data: row });
  });
  return router;
}

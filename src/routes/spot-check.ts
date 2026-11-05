import { judgeReport } from "@/audit/v2/eval/judge-report";
import { istWeekRange, istWeekStart } from "@/audit/v2/spot-check";
import { loadGoldenSet } from "@/db/golden-set";
import { BlindReviewError, drawSample, loadBlindItem, loadWeekSample, saveBlindReview } from "@/db/spot-check";
import { type AuthEnv, signedInUser } from "@/middleware/auth";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { QueryTypes, type Sequelize } from "sequelize";
import { z } from "zod";

const blindBody = z.object({
  expected_pass_fail: z.enum(["PASS", "FAIL"]),
  expected_business_outcome: z.enum(["ACHIEVED", "PARTIAL", "NOT_ACHIEVED", "NOT_APPLICABLE"]),
  expected_failure_codes: z.array(z.string()),
  note: z.string().max(4000).nullable().optional(),
});

const week = (raw: string | undefined) => {
  const w = raw || istWeekStart(new Date());
  try {
    istWeekRange(w);
  } catch (e) {
    throw new HTTPException(400, { message: (e as Error).message });
  }
  return w;
};

/**
 * Blind spot-checks (P2-18). 404 for everything while v2 is off. Never starts an audit.
 * - `GET /v2/spot-checks?week=YYYY-MM-DD` (a Monday, IST; default this week): the week's sample, drawn on first open.
 * - `POST /v2/spot-checks/top-up?week=`: draws again for agents still short, from audits made since.
 * - `GET /v2/spot-checks/items/:auditId`: transcript, recording flag and answer options, with no verdict until a blind
 *   review exists.
 * - `POST /v2/spot-checks/items/:auditId`: saves the blind answer (`kind = 'blind'`) and returns the verdict beside it.
 * - `GET /v2/spot-checks/report`: the AI judge evaluation report over the golden set as audited (`judgeReport`). Reads
 *   only: no judge call and nothing saved.
 */
export function spotCheckRouter(db: () => Sequelize, v2Enabled: () => boolean) {
  const router = new Hono<AuthEnv>();
  router.use("/v2/spot-checks/*", async (_c, next) => {
    if (!v2Enabled()) throw new HTTPException(404, { message: "Not found" });
    await next();
  });
  router.use("/v2/spot-checks", async (_c, next) => {
    if (!v2Enabled()) throw new HTTPException(404, { message: "Not found" });
    await next();
  });

  router.get("/v2/spot-checks", async (c) => c.json({ data: await loadWeekSample(db(), week(c.req.query("week")), signedInUser(c)) }));

  router.post("/v2/spot-checks/top-up", async (c) => {
    const w = week(c.req.query("week"));
    await drawSample(db(), w, signedInUser(c), { topUp: true });
    return c.json({ data: await loadWeekSample(db(), w, signedInUser(c)) });
  });

  router.get("/v2/spot-checks/report", async (c) => {
    const [rows, labels] = await Promise.all([
      loadGoldenSet(db()),
      db().query<{ code: string; label: string }>("SELECT code, label FROM failure_condition", { type: QueryTypes.SELECT }),
    ]);
    return c.json({ data: judgeReport(rows, Object.fromEntries(labels.map((l) => [l.code, l.label])), new Date()) });
  });

  const auditId = (raw: string) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) throw new HTTPException(404, { message: "Not found" });
    return n;
  };

  router.get("/v2/spot-checks/items/:auditId", async (c) => {
    const item = await loadBlindItem(db(), auditId(c.req.param("auditId")));
    if (!item) throw new HTTPException(404, { message: "Not a spot-check in any sample" });
    return c.json({ data: item });
  });

  router.post("/v2/spot-checks/items/:auditId", async (c) => {
    const answer = blindBody.parse(await c.req.json().catch(() => ({})));
    const item = await saveBlindReview(db(), auditId(c.req.param("auditId")), signedInUser(c), answer).catch((e) => {
      throw e instanceof BlindReviewError ? new HTTPException(e.status, { message: e.message }) : e;
    });
    return c.json({ data: item }, 201);
  });

  return router;
}

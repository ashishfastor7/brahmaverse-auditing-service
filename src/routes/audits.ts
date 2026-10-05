import { runAudit } from "@/audit/run-audit";
import { agents } from "@/audit/rubrics";
import { POINTS_PER_CATEGORY, SCORECARD } from "@/audit/rubrics/types";
import { tables } from "@/db";
import { playableRecordingUrl } from "@/services/recording.service";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { Op, type WhereOptions } from "sequelize";
import { z } from "zod";

const router = new Hono();

const listQuery = z.object({
  agent_code: z.string().optional(),
  business_id: z.coerce.number().optional(),
  status: z.enum(["pending", "completed", "failed", "skipped"]).optional(),
  success: z.enum(["PASS", "FAIL"]).optional(),
  goal: z.enum(["ACHIEVED", "NOT_ACHIEVED", "NOT_APPLICABLE"]).optional(),
  failure_code: z.string().optional(),
  needs_review: z.enum(["true", "false"]).optional(),
  min_score: z.coerce.number().optional(),
  max_score: z.coerce.number().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  sort: z.enum(["newest", "oldest", "score_asc", "score_desc"]).default("newest"),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
});

function whereFor(q: z.infer<typeof listQuery>) {
  const where: Record<string | symbol, unknown> = {};
  if (q.agent_code) where.agent_code = q.agent_code;
  if (q.business_id) where.business_id = q.business_id;
  if (q.status) where.status = q.status;
  if (q.success) where.success_result = q.success;
  if (q.goal) where.goal_result = q.goal;
  if (q.failure_code) where.failure_codes = { [Op.contains]: [q.failure_code] };
  if (q.needs_review) where.needs_review = q.needs_review === "true";
  if (q.min_score !== undefined || q.max_score !== undefined) {
    where.overall_score = {
      ...(q.min_score !== undefined ? { [Op.gte]: q.min_score } : {}),
      ...(q.max_score !== undefined ? { [Op.lte]: q.max_score } : {}),
    };
  }
  if (q.from || q.to) {
    where.call_created_at = {
      ...(q.from ? { [Op.gte]: new Date(q.from) } : {}),
      ...(q.to ? { [Op.lte]: new Date(q.to) } : {}),
    };
  }
  return where as WhereOptions;
}

const ORDER = {
  newest: [["call_created_at", "DESC NULLS LAST"], ["id", "DESC"]],
  oldest: [["call_created_at", "ASC NULLS LAST"], ["id", "ASC"]],
  score_asc: [["overall_score", "ASC NULLS LAST"], ["id", "DESC"]],
  score_desc: [["overall_score", "DESC NULLS LAST"], ["id", "DESC"]],
} as const;

const LIST_ATTRIBUTES = [
  "id",
  "call_id",
  "business_id",
  "agent_id",
  "agent_code",
  "rubric_version",
  "status",
  "skip_reason",
  "error",
  "overall_score",
  "quality_score",
  "success_result",
  "goal_result",
  "goal_reason_code",
  "failure_codes",
  "auditor_confidence",
  "needs_review",
  "call_created_at",
  "audited_at",
];

router.get("/audits", async (c) => {
  const q = listQuery.parse(c.req.query());
  const { rows, count } = await tables.AuditResult.findAndCountAll({
    attributes: [...LIST_ATTRIBUTES, [tables.AuditResult.sequelize!.literal(`"call"->'duration'`), "duration"]],
    where: whereFor(q),
    order: ORDER[q.sort] as any,
    limit: q.page_size,
    offset: (q.page - 1) * q.page_size,
    raw: true,
  });
  return c.json({ data: rows, page: q.page, page_size: q.page_size, total: count });
});

/** Headline numbers for the same filters as the list (minus pagination and outcome filters). */
router.get("/audits/stats", async (c) => {
  const q = listQuery.parse(c.req.query());
  const where = whereFor({ ...q, status: undefined, success: undefined, goal: undefined, failure_code: undefined, needs_review: undefined });
  const rows = await tables.AuditResult.findAll({
    attributes: ["status", "overall_score", "success_result", "goal_result", "failure_codes", "needs_review"],
    where,
    raw: true,
  });
  const completed = rows.filter((r) => r.status === "completed");
  const goalApplicable = completed.filter((r) => r.goal_result !== "NOT_APPLICABLE");
  const failureCounts = new Map<string, number>();
  for (const r of completed) for (const code of r.failure_codes ?? []) failureCounts.set(code, (failureCounts.get(code) ?? 0) + 1);

  const pct = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 1000) / 10);
  return c.json({
    data: {
      total: rows.length,
      audited: completed.length,
      skipped: rows.filter((r) => r.status === "skipped").length,
      failed_audits: rows.filter((r) => r.status === "failed").length,
      avg_score: completed.length ? Math.round(completed.reduce((s, r) => s + (r.overall_score ?? 0), 0) / completed.length) : null,
      success_rate: pct(completed.filter((r) => r.success_result === "PASS").length, completed.length),
      // Not-applicable calls (wrong person, voicemail) are excluded from the denominator.
      goal_rate: pct(goalApplicable.filter((r) => r.goal_result === "ACHIEVED").length, goalApplicable.length),
      needs_review: completed.filter((r) => r.needs_review).length,
      top_failures: [...failureCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([code, count]) => ({ code, count })),
    },
  });
});

router.get("/audits/:id", async (c) => {
  const row = await tables.AuditResult.findByPk(Number(c.req.param("id")), { raw: true });
  if (!row) throw new HTTPException(404, { message: "Audit not found" });
  return c.json({ data: row });
});

router.get("/audits/:id/recording", async (c) => {
  const row = await tables.AuditResult.findByPk(Number(c.req.param("id")), { attributes: ["call_id", "business_id", "call"], raw: true });
  if (!row) throw new HTTPException(404, { message: "Audit not found" });
  return c.json({ data: await playableRecordingUrl({ call_id: row.call_id, business_id: row.business_id, recording_url: row.call.recording_url }) });
});

/** Re-runs the judge on the stored call snapshot, e.g. after a rubric or prompt change. */
router.post("/audits/:id/reaudit", async (c) => {
  const row = await tables.AuditResult.findByPk(Number(c.req.param("id")));
  if (!row) throw new HTTPException(404, { message: "Audit not found" });
  const updated = await runAudit(row.call, { force: true }).catch((e) => {
    throw new HTTPException(502, { message: `Re-audit failed: ${(e as Error).message}` });
  });
  return c.json({ data: updated });
});

/** The agents the dashboard can filter by, and the scorecard they are graded on. */
router.get("/agents", (c) =>
  c.json({
    data: {
      agents: agents.map((a) => ({ code: a.code, label: a.label, agent_ids: a.agent_ids, rubric_version: a.rubric.version })),
      scorecard: SCORECARD.map((s) => ({ ...s, max: POINTS_PER_CATEGORY })),
    },
  }),
);

export default router;

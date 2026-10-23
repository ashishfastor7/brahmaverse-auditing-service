import { normalizeCall } from "@/audit/normalize";
import { runAudit } from "@/audit/run-audit";
import { agentFor, agents } from "@/audit/rubrics";
import { tables } from "@/db";
import { type AuditResultRow, V1, V1_EXCLUDED, withoutV2Fields } from "@/db/models/audit-result";
import { getSourceCall, listSourceCalls, sourceCallCounts, sourceDbConfigured } from "@/services/call-source.db";
import { playableRecordingUrl } from "@/services/recording.service";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { Op, type WhereOptions } from "sequelize";
import { z } from "zod";

/**
 * Every call in voice_call_logs (read-only), joined with its audit when it has one. This is what
 * the dashboard lists: audited or not, any status.
 */
const router = new Hono();

router.use("/calls/*", async (_c, next) => {
  if (!sourceDbConfigured()) throw new HTTPException(503, { message: "SOURCE_DB_* is not configured, so calls cannot be listed" });
  await next();
});
router.use("/calls", async (_c, next) => {
  if (!sourceDbConfigured()) throw new HTTPException(503, { message: "SOURCE_DB_* is not configured, so calls cannot be listed" });
  await next();
});

const listQuery = z.object({
  agent_code: z.string().optional(),
  status: z.string().optional(),
  call_type: z.enum(["inbound", "outbound"]).optional(),
  audit: z.enum(["audited", "not_audited"]).optional(),
  success: z.enum(["PASS", "FAIL"]).optional(),
  goal: z.enum(["ACHIEVED", "NOT_ACHIEVED", "NOT_APPLICABLE"]).optional(),
  failure_code: z.string().optional(),
  needs_review: z.enum(["true", "false"]).optional(),
  min_score: z.coerce.number().optional(),
  max_score: z.coerce.number().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  search: z.string().trim().optional(),
  sort: z.enum(["newest", "oldest", "score_asc", "score_desc"]).default("newest"),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
});
type ListQuery = z.infer<typeof listQuery>;

const agentIds = (code?: string) => (code ? (agents.find((a) => a.code === code)?.agent_ids ?? [-1]) : undefined);

/** Audit-side filters, applied in the audit DB and handed to the source query as an id list. */
function auditWhere(q: ListQuery): WhereOptions | null {
  const where: Record<string | symbol, unknown> = { ...V1, source: "voice_call_logs", status: "completed" };
  let any = false;
  if (q.success) ((where.success_result = q.success), (any = true));
  if (q.goal) ((where.goal_result = q.goal), (any = true));
  if (q.failure_code) ((where.failure_codes = { [Op.contains]: [q.failure_code] }), (any = true));
  if (q.needs_review) ((where.needs_review = q.needs_review === "true"), (any = true));
  if (q.min_score !== undefined || q.max_score !== undefined) {
    where.overall_score = {
      ...(q.min_score !== undefined ? { [Op.gte]: q.min_score } : {}),
      ...(q.max_score !== undefined ? { [Op.lte]: q.max_score } : {}),
    };
    any = true;
  }
  if (q.audit === "audited" || q.sort.startsWith("score")) any = true;
  return any ? (where as WhereOptions) : null;
}

const AUDIT_SUMMARY = [
  "id",
  "call_id",
  "status",
  "skip_reason",
  "overall_score",
  "success_result",
  "goal_result",
  "goal_reason_code",
  "failure_codes",
  "auditor_confidence",
  "needs_review",
  "rubric_version",
  "updated_at",
] as const;

/** The most recent audit of each call (a call can have one per rubric version). */
async function latestAudits(callIds: number[]) {
  if (callIds.length === 0) return new Map<number, Partial<AuditResultRow>>();
  const rows = await tables.AuditResult.findAll({
    attributes: [...AUDIT_SUMMARY],
    where: { ...V1, source: "voice_call_logs", call_id: { [Op.in]: callIds } },
    order: [["updated_at", "DESC"]],
    raw: true,
  });
  const map = new Map<number, Partial<AuditResultRow>>();
  for (const r of rows) if (!map.has(r.call_id)) map.set(r.call_id, r);
  return map;
}

router.get("/calls", async (c) => {
  const q = listQuery.parse(c.req.query());
  const offset = (q.page - 1) * q.page_size;
  const base = {
    agent_ids: agentIds(q.agent_code),
    status: q.status,
    call_type: q.call_type,
    from: q.from,
    to: q.to,
    search: q.search,
  };

  let rows: any[];
  let total: number;
  const aw = auditWhere(q);

  if (q.sort.startsWith("score")) {
    // Score order lives in the audit DB: page there, then fetch those calls.
    const matching = await tables.AuditResult.findAll({ attributes: ["call_id"], where: aw!, raw: true });
    const allowed = await listSourceCalls({ ...base, only_ids: matching.map((m) => m.call_id), limit: 100_000, offset: 0 });
    const allowedIds = allowed.rows.map((r) => r.id);
    const ordered = await tables.AuditResult.findAll({
      attributes: ["call_id"],
      where: { ...(aw as object), call_id: { [Op.in]: allowedIds } },
      order: [["overall_score", q.sort === "score_asc" ? "ASC NULLS LAST" : "DESC NULLS LAST"], ["call_id", "DESC"]],
      raw: true,
    });
    const pageIds = [...new Set(ordered.map((o) => o.call_id))].slice(offset, offset + q.page_size);
    const byId = new Map(allowed.rows.map((r) => [r.id, r]));
    rows = pageIds.map((id) => byId.get(id)).filter(Boolean);
    total = new Set(ordered.map((o) => o.call_id)).size;
  } else {
    let only_ids: number[] | undefined;
    let exclude_ids: number[] | undefined;
    if (aw) only_ids = (await tables.AuditResult.findAll({ attributes: ["call_id"], where: aw, raw: true })).map((r) => r.call_id);
    if (q.audit === "not_audited") {
      exclude_ids = (
        await tables.AuditResult.findAll({ attributes: ["call_id"], where: { ...V1, source: "voice_call_logs", status: "completed" }, raw: true })
      ).map((r) => r.call_id);
    }
    ({ rows, total } = await listSourceCalls({
      ...base,
      only_ids,
      exclude_ids,
      order: q.sort === "oldest" ? "oldest" : "newest",
      limit: q.page_size,
      offset,
    }));
  }

  const audits = await latestAudits(rows.map((r) => r.id));
  const data = rows.map((r) => ({
    ...r,
    agent_code: agentFor(r.agent_code, r.agent_id)?.code ?? r.agent_code,
    agent_label: agentFor(r.agent_code, r.agent_id)?.label ?? null,
    audit: audits.get(r.id) ?? null,
  }));
  return c.json({ data, page: q.page, page_size: q.page_size, total });
});

/** Headline numbers: call volumes from voice_call_logs, quality from the audits. */
router.get("/calls/stats", async (c) => {
  const agent_code = c.req.query("agent_code") || undefined;
  const counts = await sourceCallCounts(agentIds(agent_code));
  const audits = await tables.AuditResult.findAll({
    attributes: ["call_id", "status", "overall_score", "success_result", "goal_result", "failure_codes", "needs_review", "updated_at"],
    where: { ...V1, source: "voice_call_logs", ...(agent_code ? { agent_code } : {}) },
    order: [["updated_at", "DESC"]],
    raw: true,
  });
  // One audit per call: the latest.
  const seen = new Set<number>();
  const latest = audits.filter((a) => (seen.has(a.call_id) ? false : (seen.add(a.call_id), true)));
  const completed = latest.filter((r) => r.status === "completed");
  const goalApplicable = completed.filter((r) => r.goal_result !== "NOT_APPLICABLE");
  const failureCounts = new Map<string, number>();
  for (const r of completed) for (const code of r.failure_codes ?? []) failureCounts.set(code, (failureCounts.get(code) ?? 0) + 1);
  const pct = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 1000) / 10);

  return c.json({
    data: {
      total_calls: Object.values(counts).reduce((s, n) => s + n, 0),
      calls_by_status: counts,
      audited: completed.length,
      avg_score: completed.length ? Math.round(completed.reduce((s, r) => s + (r.overall_score ?? 0), 0) / completed.length) : null,
      success_rate: pct(completed.filter((r) => r.success_result === "PASS").length, completed.length),
      goal_rate: pct(goalApplicable.filter((r) => r.goal_result === "ACHIEVED").length, goalApplicable.length),
      needs_review: completed.filter((r) => r.needs_review).length,
      top_failures: [...failureCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([code, count]) => ({ code, count })),
    },
  });
});

const idParam = (raw: string) => {
  const id = Number(raw);
  if (!Number.isInteger(id)) throw new HTTPException(400, { message: "Invalid call id" });
  return id;
};

/**
 * Everything about one call. Phone numbers are included (internal dashboard); the session token,
 * join url and the queued payload's callback subjects and tool context are not.
 */
router.get("/calls/:id", async (c) => {
  const id = idParam(c.req.param("id"));
  const raw = await getSourceCall(id);
  if (!raw) throw new HTTPException(404, { message: "Call not found" });
  const input = normalizeCall(raw);
  const agent = agentFor(input.agent_code, input.agent_id);

  const audit = await tables.AuditResult.findOne({
    attributes: { exclude: V1_EXCLUDED },
    where: { ...V1, source: "voice_call_logs", call_id: id },
    order: [["updated_at", "DESC"]],
    raw: true,
  });

  return c.json({
    data: {
      call: {
        ...input,
        agent_code: agent?.code ?? input.agent_code,
        agent_label: agent?.label ?? null,
        phone_number: raw.phone_number,
        source_phone_number: raw.source_phone_number,
        provider: raw.provider,
        provider_call_id: raw.provider_call_id,
        error_detail: raw.error_detail,
        meta_data: raw.meta_data,
        tags: raw.tags ?? [],
        system_ref_id: raw.system_ref_id,
        conversation_ref: raw.conversation_ref,
        retries: raw.retries,
        scheduled_at: raw.scheduled_at,
        initiated_at: raw.initiated_at,
        picked_at: raw.picked_at,
        ends_at: raw.ends_at,
        updated_at: raw.updated_at,
        contact: raw.data?.metadata ?? null,
        channel: raw.data?.config?.channel ?? null,
        voice: raw.data?.config?.voice ?? null,
      },
      audit: audit ?? null,
    },
  });
});

router.get("/calls/:id/recording", async (c) => {
  const id = idParam(c.req.param("id"));
  const raw = await getSourceCall(id);
  if (!raw) throw new HTTPException(404, { message: "Call not found" });
  return c.json({ data: await playableRecordingUrl({ call_id: raw.id, business_id: raw.business_id, recording_url: raw.recording_url }) });
});

/** Audits (or re-audits) one call now, from its current row in voice_call_logs. */
router.post("/calls/:id/audit", async (c) => {
  const id = idParam(c.req.param("id"));
  const raw = await getSourceCall(id);
  if (!raw) throw new HTTPException(404, { message: "Call not found" });
  const row = await runAudit(normalizeCall(raw), { force: true }).catch((e) => {
    throw new HTTPException(502, { message: `Audit failed: ${(e as Error).message}` });
  });
  return c.json({ data: withoutV2Fields(row) });
});

export default router;

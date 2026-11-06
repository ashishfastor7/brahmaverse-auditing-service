import { type AuditRow, type CallRow, type Marker, agentLabel, dashboardSummary, defaultRange, previousRange } from "@/audit/v2/dashboard";
import { istDay, istDayRange } from "@/audit/v2/rollup";
import { type AuthEnv } from "@/middleware/auth";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { QueryTypes, type Sequelize } from "sequelize";
import { z } from "zod";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const query = z.object({
  from: z.string().regex(DAY).optional(),
  to: z.string().regex(DAY).optional(),
  agent: z.string().optional(),
  direction: z.enum(["inbound", "outbound", "unknown"]).optional(),
  goal: z.string().regex(/^[\w-]+@\d+$/).optional(),
  scorecard: z.string().regex(/^[\w-]+@\d+$/).optional(),
  compare: z.enum(["0", "1", "true", "false"]).optional(),
  mode: z.enum(["as_audited", "rescored"]).default("as_audited"),
});

/** At most a year per request, so the page stays fast. */
const MAX_DAYS = 366;

/**
 * P2-7 – P2-9 System Dashboard (PRD §6). 404 while v2 is off. Reads only the roll-ups (`daily_rollup`,
 * `daily_call_rollup`) and small lookups (thresholds, labels, release markers); never starts an audit.
 * - `GET /v2/dashboard?from&to&agent&direction&goal&scorecard&compare&mode`: everything the page shows in one response
 *   (`dashboardSummary`), so the page makes one request. Days are IST; default the last 7.
 */
export function dashboardRouter(db: () => Sequelize, v2Enabled: () => boolean) {
  const router = new Hono<AuthEnv>();
  router.use("/v2/dashboard", async (_c, next) => {
    if (!v2Enabled()) throw new HTTPException(404, { message: "Not found" });
    await next();
  });

  router.get("/v2/dashboard", async (c) => {
    const q = query.parse(c.req.query());
    const range = defaultRange(istDay(new Date()));
    const from = q.from ?? range.from;
    const to = q.to ?? range.to;
    try {
      istDayRange(from);
      istDayRange(to);
    } catch (e) {
      throw new HTTPException(400, { message: (e as Error).message });
    }
    if (from > to) throw new HTTPException(400, { message: "from must not be after to" });
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 + 1 > MAX_DAYS) throw new HTTPException(400, { message: `at most ${MAX_DAYS} days` });

    const compare = q.compare === "1" || q.compare === "true";
    const loadFrom = compare ? previousRange(from, to).from : from;
    const sql = <T extends object>(text: string, bind: unknown[] = []) => db().query<T>(text, { bind, type: QueryTypes.SELECT });
    const fromAt = istDayRange(from).from;
    const toAt = istDayRange(to).to;

    // Independent reads, in parallel.
    const [audits, calls, thresholds, metricLabels, conditionLabels, releases, published, scorecards, goals] = await Promise.all([
      sql<AuditRow>(
        `SELECT to_char(day, 'YYYY-MM-DD') AS day, agent_code, direction, scorecard_id, scorecard_version, goal_version, audited, sampled,
                passed, failed, needs_review, system_pass, system_fail, system_na, business_achieved, business_partial,
                business_not_achieved, business_na, score_sum::float8 AS score_sum, scored, buckets, histogram, metric_averages,
                failure_codes, system_checks, business_reasons, rs_passed, rs_failed, rs_score_sum::float8 AS rs_score_sum, rs_scored, rs_histogram
           FROM daily_rollup WHERE day BETWEEN $1 AND $2`,
        [loadFrom, to],
      ),
      sql<CallRow>(
        `SELECT to_char(day, 'YYYY-MM-DD') AS day, agent_code, direction, total, connected, not_connected
           FROM daily_call_rollup WHERE day BETWEEN $1 AND $2`,
        [loadFrom, to],
      ),
      sql<{ key: string; pass_threshold: number }>("SELECT scorecard_id || '@' || version AS key, pass_threshold::float8 AS pass_threshold FROM scorecard"),
      sql<{ key: string; name: string }>("SELECT DISTINCT ON (key) key, name FROM metric ORDER BY key, scorecard_version DESC"),
      sql<{ code: string; label: string }>("SELECT code, label FROM failure_condition"),
      sql<{ at: Date; agent_code: string; type: string; version: string | null; note: string | null }>(
        "SELECT occurred_at AS at, agent_code, type, version, note FROM release_marker WHERE occurred_at >= $1 AND occurred_at < $2",
        [fromAt, toAt],
      ),
      sql<{ at: Date; entity: string; key: string; version: number }>(
        `SELECT changed_at AS at, entity, config_key AS key, version FROM config_change
          WHERE action = 'published' AND changed_at >= $1 AND changed_at < $2`,
        [fromAt, toAt],
      ),
      sql<{ key: string; name: string; agents: string[] }>(
        `SELECT DISTINCT d.scorecard_id || '@' || d.scorecard_version AS key, s.name,
                coalesce((SELECT array_agg(agent_code ORDER BY agent_code) FROM scorecard_assignment a WHERE a.scorecard_id = d.scorecard_id), '{}') AS agents
           FROM daily_rollup d JOIN scorecard s ON s.scorecard_id = d.scorecard_id AND s.version = d.scorecard_version
          ORDER BY 1`,
      ),
      sql<{ key: string; agent_code: string; version: number; name: string | null }>(
        `SELECT DISTINCT d.agent_code || '@' || d.goal_version AS key, d.agent_code, d.goal_version AS version, g.name
           FROM daily_rollup d LEFT JOIN goal_config g ON g.agent_code = d.agent_code AND g.version = d.goal_version
          ORDER BY 1`,
      ),
    ]);

    const assigned = Object.fromEntries(scorecards.map((s) => [s.key.split("@")[0], s.agents]));
    const markers: Marker[] = [
      ...releases.map((r) => ({
        day: istDay(new Date(r.at)),
        agent_code: r.agent_code,
        type: r.type,
        label: [r.type[0]!.toUpperCase() + r.type.slice(1), r.version, r.note].filter(Boolean).join(" · "),
      })),
      ...published.flatMap((p): Marker[] => {
        const day = istDay(new Date(p.at));
        if (p.entity === "goal_config") return [{ day, agent_code: p.key, type: "goal", label: `${agentLabel(p.key)} goal v${p.version}` }];
        const owners = assigned[p.key] ?? [];
        const label = `Scorecard ${p.key} v${p.version}`;
        return owners.length ? owners.map((agent_code) => ({ day, agent_code, type: "scorecard", label })) : [{ day, agent_code: null, type: "scorecard", label }];
      }),
    ].sort((a, b) => a.day.localeCompare(b.day));

    const summary = dashboardSummary(
      audits,
      calls,
      { from, to, agent: q.agent, direction: q.direction, goal: q.goal, scorecard: q.scorecard, compare, mode: q.mode },
      {
        thresholds: Object.fromEntries(thresholds.map((t) => [t.key, t.pass_threshold])),
        metricLabels: Object.fromEntries(metricLabels.map((m) => [m.key, m.name])),
        conditionLabels: Object.fromEntries(conditionLabels.map((l) => [l.code, l.label])),
        markers,
      },
    );
    const refreshed = await sql<{ at: Date | null }>("SELECT max(refreshed_at) AS at FROM daily_call_rollup");
    return c.json({
      data: {
        ...summary,
        options: {
          agents: [...new Set([...audits, ...calls].map((r) => r.agent_code))].sort().map((code) => ({ code, label: agentLabel(code) })),
          scorecards: scorecards.map((s) => ({ key: s.key, label: `${s.name} v${s.key.split("@")[1]}` })),
          goals: goals.map((g) => ({ key: g.key, label: `${agentLabel(g.agent_code)} · ${g.name ?? "goal"} v${g.version}` })),
        },
        calls_refreshed_at: refreshed[0]?.at ?? null,
      },
    });
  });

  return router;
}

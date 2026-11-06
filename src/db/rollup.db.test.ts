import { describe, expect, it } from "bun:test";
import { type CallStatusGroup, daysBetween, histogramBin } from "@/audit/v2/rollup";
import { computeScore } from "@/audit/v2/score";
import { QueryTypes, type Sequelize } from "sequelize";
import { loadScorecard } from "./config-store";
import { createMigrator } from "./migrator";
import { type CallCountSource, rebuildAllRollups, refreshAuditDays, refreshAuditDaysQuietly, refreshCallDays } from "./rollup";
import { dbTestsEnabled, withTestDb } from "./test-db";

const select = <T extends object>(db: Sequelize, sql: string, bind: unknown[] = []) => db.query<T>(sql, { bind, type: QueryTypes.SELECT });

type Seed = {
  call_id: number;
  at: string | null;
  agent_code?: string | null;
  agent_id?: number | null;
  engine?: "v1" | "v2";
  status?: string;
  scorecard?: [string, number];
  score?: number | null;
  pass?: "PASS" | "FAIL" | null;
  system?: string | null;
  business?: string | null;
  codes?: string[];
  review?: boolean;
  metrics?: Record<string, number | null>; // null = N/A
  direction?: "inbound" | "outbound";
  goal_version?: number;
  trigger?: "single" | "sample";
  reason?: string;
  checks?: Record<string, "PASS" | "FAIL" | "NOT_APPLICABLE">;
};

/** Inserts one audit_results row (and its metric results) the way runAuditV2 leaves it. */
async function seed(db: Sequelize, s: Seed): Promise<number> {
  const [scorecardId, version] = s.scorecard ?? ["default", 2];
  const [{ id }] = (await select<{ id: number }>(
    db,
    `INSERT INTO audit_results (engine, source, call_id, business_id, agent_code, agent_id, rubric_version, status, call, result,
       call_created_at, scorecard_id, scorecard_version, score, success_result, system_goal, business_goal, failure_codes, needs_review,
       goal_version, trigger_mode, business_reason)
     VALUES ($1, 'voice_call_logs', $2, 1, $3, $4, $5, $6, $16::jsonb, '{}', $7, $8, $9, $10, $11, $12, $13, $14, $15, $17, $18, $19) RETURNING id`,
    [
      s.engine ?? "v2",
      s.call_id,
      s.agent_code === undefined ? "caller" : s.agent_code,
      s.agent_id === undefined ? 9 : s.agent_id,
      `${s.engine ?? "v2"}:${scorecardId}@${version}`,
      s.status ?? "completed",
      s.at,
      scorecardId,
      version,
      s.score === undefined ? 70 : s.score,
      s.pass === undefined ? "PASS" : s.pass,
      s.system === undefined ? "PASS" : s.system,
      s.business === undefined ? "ACHIEVED" : s.business,
      s.codes ?? [],
      s.review ?? false,
      JSON.stringify(s.direction ? { call_type: s.direction } : {}),
      s.goal_version ?? null,
      s.trigger ?? null,
      s.reason ?? null,
    ],
  ))!;
  for (const [code, result] of Object.entries(s.checks ?? {}))
    await db.query("INSERT INTO audit_check (audit_id, check_code, result) VALUES ($1, $2, $3)", { bind: [id, code, result] });
  for (const [key, score] of Object.entries(s.metrics ?? {})) {
    await db.query(
      `INSERT INTO metric_result (audit_id, metric_id, score, max, n_a)
       SELECT $1, id, $3, 10, $4 FROM metric WHERE scorecard_id = $5 AND scorecard_version = $6 AND key = $2`,
      { bind: [id, key, score, score === null, scorecardId, version] },
    );
  }
  return id;
}

const supersede = (db: Sequelize, oldId: number, newId: number) =>
  db.query("UPDATE audit_results SET superseded_by = $2 WHERE id = $1", { bind: [oldId, newId] });

/**
 * The roll-up written independently: one SQL pass over the raw audits (no shared code with buildAuditRollups apart
 * from the agent list), shaped like `daily_rollup`.
 */
async function directQuery(db: Sequelize) {
  const CURRENT = `WITH cur AS (
    SELECT a.*, to_char((call_created_at AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS day,
      CASE WHEN lower(agent_code) IN ('hrms', 'project-manager', 'caller') THEN lower(agent_code)
           WHEN agent_id = 1 THEN 'hrms' WHEN agent_id = 4 THEN 'project-manager' WHEN agent_id = 9 THEN 'caller'
           ELSE 'unknown' END AS agent,
      CASE WHEN call->>'call_type' IN ('inbound', 'outbound') THEN call->>'call_type' ELSE 'unknown' END AS dir,
      coalesce(goal_version, 0) AS gv
      FROM audit_results a
     WHERE engine = 'v2' AND status = 'completed' AND superseded_by IS NULL AND call_created_at IS NOT NULL)`;
  const KEY = "day, agent, dir, scorecard_id, scorecard_version, gv";
  const QKEY = "cur.day, cur.agent, cur.dir, cur.scorecard_id, cur.scorecard_version, cur.gv";
  const heads = await select<any>(
    db,
    `${CURRENT}
     SELECT day, agent AS agent_code, dir AS direction, scorecard_id, scorecard_version, gv AS goal_version, count(*)::int AS audited,
       count(*) FILTER (WHERE trigger_mode = 'sample')::int AS sampled,
       count(*) FILTER (WHERE success_result = 'PASS')::int AS passed,
       count(*) FILTER (WHERE success_result = 'FAIL')::int AS failed,
       count(*) FILTER (WHERE needs_review)::int AS needs_review,
       count(*) FILTER (WHERE system_goal = 'PASS')::int AS system_pass,
       count(*) FILTER (WHERE system_goal = 'FAIL')::int AS system_fail,
       count(*) FILTER (WHERE system_goal IS NULL OR system_goal = 'NOT_APPLICABLE')::int AS system_na,
       count(*) FILTER (WHERE business_goal = 'ACHIEVED')::int AS business_achieved,
       count(*) FILTER (WHERE business_goal = 'PARTIAL')::int AS business_partial,
       count(*) FILTER (WHERE business_goal = 'NOT_ACHIEVED')::int AS business_not_achieved,
       count(*) FILTER (WHERE business_goal IS NULL OR business_goal = 'NOT_APPLICABLE')::int AS business_na,
       coalesce(sum(score), 0)::float8 AS score_sum, count(score)::int AS scored,
       jsonb_build_object(
         'success', count(*) FILTER (WHERE system_goal = 'PASS' AND business_goal = 'ACHIEVED'),
         'business_miss', count(*) FILTER (WHERE system_goal = 'PASS' AND business_goal IN ('PARTIAL', 'NOT_ACHIEVED')),
         'ai_failure', count(*) FILTER (WHERE system_goal = 'FAIL' AND business_goal IN ('PARTIAL', 'NOT_ACHIEVED')),
         'achieved_despite_ai', count(*) FILTER (WHERE system_goal = 'FAIL' AND business_goal = 'ACHIEVED'),
         'na', count(*) FILTER (WHERE system_goal IS NULL OR system_goal = 'NOT_APPLICABLE' OR business_goal IS NULL OR business_goal = 'NOT_APPLICABLE')
       ) AS buckets,
       ARRAY[count(*) FILTER (WHERE score < 20), count(*) FILTER (WHERE score >= 20 AND score < 40),
             count(*) FILTER (WHERE score >= 40 AND score < 60), count(*) FILTER (WHERE score >= 60 AND score < 80),
             count(*) FILTER (WHERE score >= 80)]::int[] AS histogram
     FROM cur GROUP BY ${KEY} ORDER BY ${KEY}`,
  );
  const codes = await select<any>(
    db,
    `${CURRENT} SELECT ${KEY}, code, count(DISTINCT id)::int AS n FROM cur, unnest(failure_codes) AS code GROUP BY ${KEY}, code`,
  );
  const metrics = await select<any>(
    db,
    `${CURRENT} SELECT ${QKEY}, m.key, count(*)::int AS n, sum(r.score)::float8 AS score_sum, sum(r.max)::float8 AS max_sum,
       count(*) FILTER (WHERE r.score < r.max)::int AS lost
       FROM cur JOIN metric_result r ON r.audit_id = cur.id JOIN metric m ON m.id = r.metric_id
      WHERE NOT r.n_a GROUP BY ${QKEY}, m.key`,
  );
  const checks = await select<any>(
    db,
    `${CURRENT} SELECT ${QKEY}, c.check_code AS code,
       count(*) FILTER (WHERE c.result = 'PASS')::int AS pass, count(*) FILTER (WHERE c.result = 'FAIL')::int AS fail,
       count(*) FILTER (WHERE c.result = 'NOT_APPLICABLE')::int AS na
       FROM cur JOIN audit_check c ON c.audit_id = cur.id GROUP BY ${QKEY}, c.check_code`,
  );
  const reasons = await select<any>(
    db,
    `${CURRENT} SELECT ${KEY}, coalesce(nullif(business_reason, ''), 'UNSPECIFIED') AS reason, count(*)::int AS n
       FROM cur WHERE business_goal = 'NOT_ACHIEVED' GROUP BY ${KEY}, 7`,
  );
  const rescored = await rescoredByAudit(db);
  const ids = await select<any>(db, `${CURRENT} SELECT ${KEY}, id FROM cur`);
  const same = (h: any) => (x: any) =>
    x.day === h.day &&
    x.agent === h.agent_code &&
    x.dir === h.direction &&
    x.scorecard_id === h.scorecard_id &&
    x.scorecard_version === h.scorecard_version &&
    x.gv === h.goal_version;
  return heads.map((h) => {
    const rs = ids.filter(same(h)).flatMap((x) => (rescored.has(x.id) ? [rescored.get(x.id)!] : []));
    const scored = rs.filter((r) => r.score !== null);
    const histogram = [0, 0, 0, 0, 0];
    for (const r of scored) histogram[histogramBin(r.score!)]!++;
    return {
      ...h,
      metric_averages: Object.fromEntries(
        metrics.filter(same(h)).map((m) => [m.key, { n: m.n, score_sum: m.score_sum, max_sum: m.max_sum, lost: m.lost }]),
      ),
      failure_codes: Object.fromEntries(codes.filter(same(h)).map((c) => [c.code, c.n])),
      system_checks: Object.fromEntries(checks.filter(same(h)).map((c) => [c.code, { pass: c.pass, fail: c.fail, na: c.na }])),
      business_reasons: Object.fromEntries(reasons.filter(same(h)).map((r) => [r.reason, r.n])),
      rs_passed: rs.filter((r) => r.passed).length,
      rs_failed: rs.filter((r) => !r.passed).length,
      rs_score_sum: Math.round(scored.reduce((sum, r) => sum + r.score!, 0) * 10) / 10,
      rs_scored: scored.length,
      rs_histogram: histogram,
    };
  });
}

/**
 * Every current audit's re-scored result, one at a time: its metric results and flags scored with its agent's
 * assigned scorecard; with no metric results, the audited verdict (skipping audits with none).
 */
async function rescoredByAudit(db: Sequelize) {
  const audits = await select<any>(
    db,
    `SELECT a.id, a.score::float8 AS score, a.success_result, sa.scorecard_id AS sid, sa.scorecard_version AS sv
       FROM audit_results a
       LEFT JOIN scorecard_assignment sa ON sa.agent_code = CASE WHEN lower(a.agent_code) IN ('hrms', 'project-manager', 'caller') THEN lower(a.agent_code)
         WHEN a.agent_id = 1 THEN 'hrms' WHEN a.agent_id = 4 THEN 'project-manager' WHEN a.agent_id = 9 THEN 'caller' END
      WHERE a.engine = 'v2' AND a.status = 'completed' AND a.superseded_by IS NULL AND a.call_created_at IS NOT NULL`,
  );
  const out = new Map<number, { score: number | null; passed: boolean }>();
  for (const a of audits) {
    const metrics = await select<any>(
      db,
      `SELECT m.key, r.score::float8 AS score, r.max::float8 AS max, r.n_a FROM metric_result r JOIN metric m ON m.id = r.metric_id WHERE r.audit_id = $1`,
      [a.id],
    );
    if (a.sid && metrics.length) {
      const scorecard = (await loadScorecard(db, a.sid, a.sv))!;
      const weights = Object.fromEntries(scorecard.metrics.map((m) => [m.key, m.weight]));
      const flags = await select<any>(db, "SELECT condition_code AS code, source, evidence FROM failure_flag WHERE audit_id = $1 ORDER BY id", [a.id]);
      const { score, passed } = computeScore(metrics, weights, scorecard, flags);
      out.set(a.id, { score, passed });
    } else if (a.success_result) out.set(a.id, { score: a.score, passed: a.success_result === "PASS" });
  }
  return out;
}

const stored = (db: Sequelize) =>
  select<any>(
    db,
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, agent_code, direction, scorecard_id, scorecard_version, goal_version, audited, sampled,
       passed, failed, needs_review,
       system_pass, system_fail, system_na, business_achieved, business_partial, business_not_achieved, business_na,
       score_sum::float8 AS score_sum, scored, buckets, histogram, metric_averages, failure_codes, system_checks, business_reasons,
       rs_passed, rs_failed, rs_score_sum::float8 AS rs_score_sum, rs_scored, rs_histogram
       FROM daily_rollup ORDER BY day, agent_code, direction, scorecard_id, scorecard_version, goal_version`,
  );

const storedCalls = (db: Sequelize) =>
  select<any>(
    db,
    "SELECT to_char(day, 'YYYY-MM-DD') AS day, agent_code, direction, total, connected, not_connected FROM daily_call_rollup ORDER BY day, agent_code, direction",
  );

/** Six current audits over three IST days, plus every kind of row the roll-up must leave out. */
async function seedSample(db: Sequelize) {
  const old101 = await seed(db, { call_id: 101, at: "2026-11-01T05:00:00Z", score: 10, pass: "FAIL" });
  const a101 = await seed(db, {
    call_id: 101,
    at: "2026-11-01T05:00:00Z",
    score: 82,
    metrics: { flow_adherence: 8, repetition: 4, troubleshooting: null },
    direction: "outbound",
    goal_version: 1,
    trigger: "sample",
    checks: { S1: "PASS", S2: "PASS", S3: "PASS", S4: "NOT_APPLICABLE" },
  });
  await supersede(db, old101, a101);
  // 23:59 IST on 1 Nov, by agent_id only
  await seed(db, {
    call_id: 102,
    at: "2026-11-01T18:29:00Z",
    agent_code: null,
    score: 35.5,
    pass: "FAIL",
    system: "FAIL",
    business: "PARTIAL",
    review: true,
    codes: ["AGENT_LOOP", "AGENT_LOOP"],
    metrics: { repetition: 0, flow_adherence: 6 },
    direction: "outbound",
    goal_version: 1,
    trigger: "single",
    checks: { S1: "PASS", S2: "FAIL" },
  });
  // 00:00 IST on 2 Nov
  const a103 = await seed(db, {
    call_id: 103,
    at: "2026-11-01T18:30:00Z",
    score: 100,
    business: "NOT_ACHIEVED",
    reason: "PRICE",
    metrics: { repetition: 10 },
    direction: "inbound",
  });
  await seed(db, {
    call_id: 104,
    at: "2026-11-02T06:00:00Z",
    agent_code: null,
    agent_id: 1,
    scorecard: ["hansa", 2],
    score: 20,
    pass: "FAIL",
    system: "FAIL",
    codes: ["CALL_ERROR"],
  });
  await seed(db, { call_id: 105, at: "2026-11-02T07:00:00Z", score: null, pass: null, system: "NOT_APPLICABLE", business: null });
  await seed(db, { call_id: 112, at: "2026-11-02T07:30:00Z", business: "NOT_ACHIEVED", direction: "inbound" });
  await seed(db, { call_id: 106, at: "2026-11-03T07:00:00Z", agent_code: null, agent_id: 77, score: 60, business: "NOT_APPLICABLE" });
  // never counted
  await seed(db, { call_id: 107, at: "2026-11-02T08:00:00Z", status: "failed", score: null, pass: null, system: null, business: null });
  await seed(db, { call_id: 108, at: "2026-11-02T08:00:00Z", status: "skipped", score: null, pass: null, system: null, business: null });
  await seed(db, { call_id: 109, at: "2026-11-02T08:00:00Z", status: "pending", score: null, pass: null, system: null, business: null });
  await seed(db, { call_id: 110, at: "2026-11-02T08:00:00Z", engine: "v1", scorecard: ["default", 1] });
  await seed(db, { call_id: 111, at: null });
  return { a103 };
}

const SAMPLE_DAYS = daysBetween("2026-10-31", "2026-11-03");

describe.skipIf(!dbTestsEnabled)("daily roll-ups (P2-6, P2-7)", () => {
  it("equal a direct query over the raw audits, before and after a re-audit, and after a full rebuild", () =>
    withTestDb(async (db) => {
      await createMigrator(db, { quiet: true }).up();
      const { a103 } = await seedSample(db);
      // a stale row for a day with no audits must go
      await db.query("INSERT INTO daily_rollup (day, agent_code, scorecard_id, scorecard_version, audited) VALUES ('2026-10-31', 'caller', 'default', 2, 9)");

      await refreshAuditDays(db, SAMPLE_DAYS);
      const direct = await directQuery(db);
      expect(direct.map((r) => [r.day, r.agent_code, r.direction, r.scorecard_id, r.scorecard_version, r.goal_version, r.audited])).toEqual([
        ["2026-11-01", "caller", "outbound", "default", 2, 1, 2],
        ["2026-11-02", "caller", "inbound", "default", 2, 0, 2],
        ["2026-11-02", "caller", "unknown", "default", 2, 0, 1],
        ["2026-11-02", "hrms", "unknown", "hansa", 2, 0, 1],
        ["2026-11-03", "unknown", "unknown", "default", 2, 0, 1],
      ]);
      expect(await stored(db)).toEqual(direct);
      // spot-check one row by hand, so the two can't agree on a shared mistake
      expect((await stored(db))[0]).toMatchObject({
        passed: 1,
        failed: 1,
        score_sum: 117.5,
        histogram: [0, 1, 0, 0, 1],
        buckets: { success: 1, business_miss: 0, ai_failure: 1, achieved_despite_ai: 0, na: 0 },
        metric_averages: { flow_adherence: { n: 2, score_sum: 14, max_sum: 20, lost: 2 }, repetition: { n: 2, score_sum: 4, max_sum: 20, lost: 2 } },
        failure_codes: { AGENT_LOOP: 1 },
        sampled: 1,
        system_checks: { S1: { pass: 2, fail: 0, na: 0 }, S2: { pass: 1, fail: 1, na: 0 }, S3: { pass: 1, fail: 0, na: 0 }, S4: { pass: 0, fail: 0, na: 1 } },
        business_reasons: {},
      });
      expect((await stored(db))[1]).toMatchObject({ business_reasons: { PRICE: 1, UNSPECIFIED: 1 } });

      // a re-audit of call 103 under another scorecard version supersedes the old one; the hook refreshes its day
      const reaudit = await seed(db, { call_id: 103, at: "2026-11-01T18:30:00Z", scorecard: ["default", 1], score: 55 });
      await supersede(db, a103, reaudit);
      await refreshAuditDaysQuietly(db, "2026-11-01T18:30:00Z", "test re-audit");
      const afterReaudit = await directQuery(db);
      expect(
        afterReaudit.filter((r) => r.day === "2026-11-02" && r.agent_code === "caller").map((r) => [r.direction, r.scorecard_version, r.audited]),
      ).toEqual([
        ["inbound", 2, 1],
        ["unknown", 1, 1],
        ["unknown", 2, 1],
      ]);
      expect(await stored(db)).toEqual(afterReaudit);

      // the nightly rebuild gives the same rows
      await rebuildAllRollups(db, null);
      expect(await stored(db)).toEqual(afterReaudit);
    }));

  it("count source calls per IST day and agent: completed connected, no_answer + failed not, the rest only in total", () =>
    withTestDb(async (db) => {
      await createMigrator(db, { quiet: true }).up();
      const groups: CallStatusGroup[] = [
        { day: "2026-11-01", agent_code: null, agent_id: 9, status: "completed", n: 4 },
        { day: "2026-11-01", agent_code: null, agent_id: 9, status: "no_answer", n: 3 },
        { day: "2026-11-01", agent_code: "caller", agent_id: null, status: "failed", n: 1 },
        { day: "2026-11-01", agent_code: null, agent_id: 9, status: "dialing", n: 2 },
        { day: "2026-11-02", agent_code: null, agent_id: 1, status: "completed", n: 5 },
        { day: "2026-11-02", agent_code: null, agent_id: 1, call_type: "inbound", status: "no_answer", n: 2 },
      ];
      const asked: { from: Date; to: Date }[] = [];
      const source: CallCountSource = async (range) => {
        if (range) asked.push(range);
        return groups;
      };

      await refreshCallDays(db, source, ["2026-11-01"]);
      expect(asked).toEqual([{ from: new Date("2026-10-31T18:30:00Z"), to: new Date("2026-11-01T18:30:00Z") }]);
      expect(await storedCalls(db)).toEqual([{ day: "2026-11-01", agent_code: "caller", direction: "unknown", total: 10, connected: 4, not_connected: 4 }]);

      await rebuildAllRollups(db, source);
      expect(await storedCalls(db)).toEqual([
        { day: "2026-11-01", agent_code: "caller", direction: "unknown", total: 10, connected: 4, not_connected: 4 },
        { day: "2026-11-02", agent_code: "hrms", direction: "inbound", total: 2, connected: 0, not_connected: 2 },
        { day: "2026-11-02", agent_code: "hrms", direction: "unknown", total: 5, connected: 5, not_connected: 0 },
      ]);

      // without a source the call table is left as it is
      await rebuildAllRollups(db, null);
      expect(await storedCalls(db)).toHaveLength(3);
    }));
});

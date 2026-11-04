import { type BlindAnswer, compareBlind, istWeekRange, pickSpotChecks, SPOT_CHECKS_PER_AGENT, type Shortfall } from "@/audit/v2/spot-check";
import { QueryTypes, type Sequelize, type Transaction } from "sequelize";
import { type AuditRowView, insertReview, loadAuditContext, loadAuditRow, offeredOutcomes, type ReviewRow } from "./audit-view";

/**
 * Blind spot-check storage (P2-18, migration 0017). A week's sample is the union of its draws. The first open of a week
 * draws it; *Top up* draws again for agents that were short, from audits made since. Never starts an audit.
 */

const select = <T extends object>(db: Sequelize, sql: string, bind: unknown[], transaction?: Transaction) =>
  db.query<T>(sql, { bind, type: QueryTypes.SELECT, transaction });

export type SampleItem = {
  audit_id: number;
  call_id: number;
  agent_code: string;
  call_created_at: string | null;
  duration: number | null;
  /** Whether a blind review of this audit exists. */
  done: boolean;
};
export type WeekSample = {
  week_start: string;
  per_agent: number;
  draws: { id: number; seed: number; created_by: string; created_at: string; picked: number }[];
  agents: { agent_code: string; wanted: number; picked: number; items: SampleItem[] }[];
  shortfall: Shortfall[];
  /** Audits made since the last draw that could fill a shortfall (offer *Top up* when > 0). */
  can_top_up: number;
};

/** Current completed v2 audits of calls created in the week, with the agent they belong to. */
async function candidates(db: Sequelize, weekStart: string, transaction?: Transaction) {
  const { from, to } = istWeekRange(weekStart);
  return select<{ audit_id: number; agent_code: string }>(
    db,
    `SELECT id AS audit_id, agent_code FROM audit_results
      WHERE engine = 'v2' AND status = 'completed' AND superseded_by IS NULL AND agent_code IS NOT NULL
        AND call_created_at >= $1 AND call_created_at < $2`,
    [from, to],
    transaction,
  );
}

/** Agents with a v2 scorecard, so an agent with no audits at all is still reported as short. */
const v2Agents = async (db: Sequelize, transaction?: Transaction) =>
  (await select<{ agent_code: string }>(db, "SELECT agent_code FROM scorecard_assignment ORDER BY agent_code", [], transaction)).map((r) => r.agent_code);

type Draw = { id: number; seed: string | number; per_agent: number; audit_ids: number[]; candidate_ids: number[]; created_by: string; created_at: string };
const draws = (db: Sequelize, weekStart: string, transaction?: Transaction) =>
  select<Draw>(db, "SELECT * FROM spot_check_sample WHERE week_start = $1 ORDER BY id", [weekStart], transaction);

const newSeed = () => Math.floor(Math.random() * 2 ** 32);

/**
 * Draws for the week: the first call draws `perAgent` per agent; with `topUp`, a later call draws again for the agents
 * still short, from candidates not seen by an earlier draw. Each draw stores its seed and candidates. Under an advisory
 * lock per week, so two reviewers opening the page at once don't draw twice.
 */
export async function drawSample(db: Sequelize, weekStart: string, createdBy: string, opts: { topUp?: boolean; perAgent?: number; seed?: number } = {}) {
  istWeekRange(weekStart);
  return db.transaction(async (transaction) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('spot_check_sample'), hashtext($1))", { bind: [weekStart], transaction });
    const existing = await draws(db, weekStart, transaction);
    if (existing.length && !opts.topUp) return;
    const perAgent = existing[0]?.per_agent ?? opts.perAgent ?? SPOT_CHECKS_PER_AGENT;
    const seen = new Set(existing.flatMap((d) => d.candidate_ids));
    const picked = existing.flatMap((d) => d.audit_ids);
    const all = await candidates(db, weekStart, transaction);
    const pickedPerAgent = new Map<string, number>();
    for (const c of all) if (picked.includes(c.audit_id)) pickedPerAgent.set(c.agent_code, (pickedPerAgent.get(c.agent_code) ?? 0) + 1);
    const pool = all.filter((c) => !seen.has(c.audit_id) && (pickedPerAgent.get(c.agent_code) ?? 0) < perAgent);
    if (existing.length && pool.length === 0) return;
    // A top-up gives each agent only what it is still short of.
    const seed = opts.seed ?? newSeed();
    const auditIds = pickSpotChecks(pool, seed, (agent) => perAgent - (pickedPerAgent.get(agent) ?? 0)).picks.map((p) => p.audit_id);
    await db.query(
      `INSERT INTO spot_check_sample (week_start, seed, per_agent, candidate_ids, audit_ids, created_by) VALUES ($1, $2, $3, $4, $5, $6)`,
      { bind: [weekStart, seed, perAgent, pool.map((c) => c.audit_id).sort((a, b) => a - b), auditIds, createdBy], transaction },
    );
  });
}

/** The week's sample as the spot-check page shows it. Draws it first if the week has none. */
export async function loadWeekSample(db: Sequelize, weekStart: string, createdBy: string): Promise<WeekSample> {
  await drawSample(db, weekStart, createdBy);
  const list = await draws(db, weekStart);
  const perAgent = list[0]?.per_agent ?? SPOT_CHECKS_PER_AGENT;
  const ids = list.flatMap((d) => d.audit_ids);
  const items = await select<SampleItem>(
    db,
    `SELECT a.id AS audit_id, a.call_id, a.agent_code, a.call_created_at, (a.call->>'duration')::float8 AS duration,
            EXISTS (SELECT 1 FROM review r WHERE r.audit_id = a.id AND r.kind = 'blind') AS done
       FROM audit_results a WHERE a.id = ANY($1) ORDER BY a.call_created_at, a.id`,
    [ids],
  );
  const agents = [...new Set([...(await v2Agents(db)), ...items.map((i) => i.agent_code)])].sort();
  const seen = new Set(list.flatMap((d) => d.candidate_ids));
  const fresh = (await candidates(db, weekStart)).filter((c) => !seen.has(c.audit_id));
  const byAgent = agents.map((agent_code) => {
    const mine = items.filter((i) => i.agent_code === agent_code);
    return { agent_code, wanted: perAgent, picked: mine.length, items: mine };
  });
  const shortfall = byAgent.filter((a) => a.picked < perAgent).map((a) => ({ agent_code: a.agent_code, available: a.picked, wanted: perAgent }));
  return {
    week_start: weekStart,
    per_agent: perAgent,
    draws: list.map((d) => ({ id: d.id, seed: Number(d.seed), created_by: d.created_by, created_at: d.created_at, picked: d.audit_ids.length })),
    agents: byAgent,
    shortfall,
    can_top_up: fresh.filter((c) => shortfall.some((s) => s.agent_code === c.agent_code)).length,
  };
}

/** Whether the audit is in any week's sample. */
export async function inSample(db: Sequelize, auditId: number): Promise<boolean> {
  const [row] = await select<{ n: number }>(db, "SELECT count(*)::int AS n FROM spot_check_sample WHERE $1 = ANY(audit_ids)", [auditId]);
  return row!.n > 0;
}

/** The judge's verdict on the three things a blind check asks (PRD §9 gate). */
export function judgeVerdict(audit: AuditRowView) {
  return {
    pass_fail: audit.success_result,
    business_outcome: audit.result?.business_goal?.outcome ?? null,
    failure_codes: (audit.result?.flags ?? []).map((f) => f.code).sort(),
  };
}

export type BlindItem = {
  audit_id: number;
  call_id: number;
  agent_code: string | null;
  call: { call_type: string | null; duration: number | null; call_created_at: string | null; has_recording: boolean; transcript: { turn: number; speaker: string; text: string }[] };
  options: { outcomes: string[]; failure_codes: { code: string; label: string; definition: string }[] };
  /** Null until a blind review is saved: the judge's verdict is never sent before (P2-18). */
  revealed: null | {
    review: ReviewRow;
    judge: ReturnType<typeof judgeVerdict> & { score: number | null; reason_code: string | null };
    comparison: ReturnType<typeof compareBlind>;
  };
};

/**
 * One blind item. Built field by field from the call snapshot and the scorecard's options, so nothing from the
 * judge's answer is in it until a blind review exists. Null when the audit isn't in a sample or isn't a completed v2 audit.
 */
export async function loadBlindItem(db: Sequelize, auditId: number): Promise<BlindItem | null> {
  const audit = await loadAuditRow(db, auditId);
  if (!audit || audit.status !== "completed" || !(await inSample(db, auditId))) return null;
  const [snapshot] = await select<{ call: any }>(db, "SELECT call FROM audit_results WHERE id = $1", [auditId]);
  const call = snapshot!.call ?? {};
  const context = await loadAuditContext(db, { ...audit, result: null }); // no flagged codes: they would hint at the verdict
  const [review] = await select<ReviewRow>(db, "SELECT * FROM review WHERE audit_id = $1 AND kind = 'blind' ORDER BY id LIMIT 1", [auditId]);
  const rule = await select<{ code: string; label: string; definition: string }>(
    db,
    "SELECT code, label, definition FROM failure_condition WHERE code IN ('CALL_ERROR', 'NO_AGENT_SPEECH') ORDER BY code",
    [],
  );
  const codes = [...context.conditions.filter((c) => c.enabled).map(({ code, label, definition }) => ({ code, label, definition })), ...rule];
  return {
    audit_id: audit.id,
    call_id: audit.call_id,
    agent_code: audit.agent_code,
    call: {
      call_type: call.call_type ?? null,
      duration: call.duration ?? null,
      call_created_at: call.call_created_at ?? null,
      has_recording: Boolean(call.recording_url),
      transcript: (call.transcript ?? []).map((t: any) => ({ turn: t.turn, speaker: t.speaker, text: t.text })),
    },
    options: { outcomes: context.goal?.outcomes ?? offeredOutcomes([]), failure_codes: [...new Map(codes.map((c) => [c.code, c])).values()] },
    revealed: review ? reveal(audit, review) : null,
  };
}

function reveal(audit: AuditRowView, review: ReviewRow): NonNullable<BlindItem["revealed"]> {
  const judge = judgeVerdict(audit);
  return {
    review,
    judge: { ...judge, score: audit.score, reason_code: audit.result?.business_goal?.reason_code ?? null },
    comparison: compareBlind(
      {
        expected_pass_fail: review.expected_pass_fail!,
        expected_business_outcome: review.expected_business_outcome!,
        expected_failure_codes: review.expected_failure_codes ?? [],
      },
      judge,
    ),
  };
}

export class BlindReviewError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
  }
}

/** Saves the blind answer (`kind = 'blind'`, agree when all three match the judge) and returns the revealed item. */
export async function saveBlindReview(db: Sequelize, auditId: number, reviewer: string, answer: BlindAnswer & { note?: string | null }): Promise<BlindItem> {
  const item = await loadBlindItem(db, auditId);
  if (!item) throw new BlindReviewError("Not a spot-check in any sample", 404);
  if (item.revealed) throw new BlindReviewError("This call already has a blind check", 409);
  if (!item.options.outcomes.includes(answer.expected_business_outcome))
    throw new BlindReviewError(`${answer.expected_business_outcome} isn't an outcome this agent's goal offers`, 400);
  const unknown = answer.expected_failure_codes.filter((c) => !item.options.failure_codes.some((o) => o.code === c));
  if (unknown.length) throw new BlindReviewError(`${unknown.join(", ")} isn't a failure condition on this scorecard`, 400);
  const audit = (await loadAuditRow(db, auditId))!;
  const { agree } = compareBlind(answer, judgeVerdict(audit));
  await db.transaction(async (transaction) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('blind_review'), $1)", { bind: [auditId], transaction });
    const [exists] = await select<{ id: number }>(db, "SELECT id FROM review WHERE audit_id = $1 AND kind = 'blind'", [auditId], transaction);
    if (exists) throw new BlindReviewError("This call already has a blind check", 409);
    await insertReview(
      db,
      auditId,
      reviewer,
      "blind",
      {
        verdict: agree ? "agree" : "dispute",
        note: answer.note,
        expected_pass_fail: answer.expected_pass_fail,
        expected_business_outcome: answer.expected_business_outcome,
        expected_failure_codes: [...new Set(answer.expected_failure_codes)].sort(),
      },
      transaction,
    );
  });
  return (await loadBlindItem(db, auditId))!;
}

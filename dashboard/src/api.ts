const BASE = (import.meta.env.VITE_AUDIT_API_URL as string | undefined) ?? "http://localhost:8095";
const TOKEN_KEY = "audit-token";

export const tokenStore = {
  get: () => {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set: (t: string | null) => {
    try {
      if (t) localStorage.setItem(TOKEN_KEY, t);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* storage unavailable: the token lives for this page only */
    }
  },
};

export class UnauthorizedError extends Error {}

/** Why a sign-in didn't work: wrong credentials, too many tries (with the wait), or the service is unreachable. */
export class SignInError extends Error {
  constructor(
    readonly reason: "credentials" | "throttled" | "unreachable",
    readonly retryAfterSeconds = 0,
  ) {
    super(reason);
  }
}

export const authApi = {
  /** Signs in and keeps the session token for every later request. */
  login: async (username: string, password: string) => {
    const res = await fetch(`${BASE}/v1/audit/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    }).catch(() => null);
    if (!res) throw new SignInError("unreachable");
    if (res.status === 401) throw new SignInError("credentials");
    if (res.status === 429) throw new SignInError("throttled", Number(res.headers.get("Retry-After")) || 60);
    if (!res.ok) throw new SignInError("unreachable");
    const { data } = (await res.json()) as { data: { token: string; username: string; expires_at: string } };
    tokenStore.set(data.token);
    return data;
  },
  /** Ends the session on the server (best effort) and forgets the token. */
  logout: async () => {
    await call("/auth/logout", { method: "POST" }).catch(() => {});
    tokenStore.set(null);
  },
  me: () => call<{ data: { username: string } }>("/auth/me").then((r) => r.data),
};

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}/v1/audit${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenStore.get() ?? ""}`, ...init?.headers },
  });
  if (res.status === 401) throw new UnauthorizedError("Unauthorized");
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message ?? `Request failed (${res.status})`);
  return body as T;
}

export type Evidence = { turn: number; quote: string; valid?: boolean };
/** One scorecard category: points out of `max` (20), null when not applicable. */
export type Metric = { label: string; applicable: boolean; score: number | null; max: number; reasoning: string; evidence: Evidence[] };
export type Failure = {
  code: string;
  source: "rule" | "llm";
  explanation: string;
  /** Every turn involved; absent on audits made before rubric v3. */
  evidence?: Evidence[];
  turn: number | null;
  quote: string | null;
};

/** All the turns a failure cites (older audits only stored one). */
export const failureEvidence = (f: Failure): Evidence[] =>
  f.evidence?.length ? f.evidence : f.turn !== null && f.quote ? [{ turn: f.turn, quote: f.quote, valid: (f as Evidence).valid }] : [];
export type Turn = { turn: number; speaker: string; text: string };

export type AuditResult = {
  overall_score: number | null;
  quality_score: number | null;
  call_success: { result: "PASS" | "FAIL"; failure_reasons: Failure[] };
  call_goal: { result: "ACHIEVED" | "NOT_ACHIEVED" | "NOT_APPLICABLE"; reason_code: string; explanation: string; evidence: Evidence[] };
  metrics: Record<string, Metric>;
  call_summary: string;
  went_well: { point: string; turn: number; quote: string; valid?: boolean }[];
  improvements: { point: string; suggestion: string; turn: number; quote: string; severity: "low" | "medium" | "high"; valid?: boolean }[];
  sentiment: { start: string; end: string; note: string };
  conclusion: string;
  auditor_confidence: number;
  needs_review: boolean;
  rubric_version: string;
  agent_label: string | null;
  judge: {
    model: string;
    prompt_used: { prompt_code: string; version: number } | null;
    transcript_quality: string;
    evidence_validity: number;
    self_confidence: number;
  };
};

export type AuditCall = {
  call_id: number;
  business_id: number;
  agent_code: string | null;
  prompt_code: string | null;
  status: string;
  call_type: string | null;
  agent_id: number | null;
  recording_url: string | null;
  duration: number | null;
  ended_reason: string | null;
  summary: string | null;
  outcome: Record<string, unknown> | null;
  transcript: Turn[];
  variables: Record<string, unknown>;
  call_created_at: string | null;
};

export type AuditStatus = "pending" | "completed" | "failed" | "skipped";

export type AuditListRow = {
  id: number;
  call_id: number;
  business_id: number;
  agent_code: string | null;
  rubric_version: string;
  status: AuditStatus;
  skip_reason: string | null;
  error: string | null;
  overall_score: number | null;
  success_result: "PASS" | "FAIL" | null;
  goal_result: AuditResult["call_goal"]["result"] | null;
  goal_reason_code: string | null;
  failure_codes: string[];
  auditor_confidence: number | null;
  needs_review: boolean;
  duration: number | null;
  call_created_at: string | null;
};

export type AuditDetail = AuditListRow & {
  result: AuditResult | null;
  call: AuditCall;
  judge_model: string | null;
  latency_ms: number | null;
  audited_at: string | null;
};

export type Stats = {
  total: number;
  audited: number;
  skipped: number;
  failed_audits: number;
  avg_score: number | null;
  success_rate: number | null;
  goal_rate: number | null;
  needs_review: number;
  top_failures: { code: string; count: number }[];
};

export type Agents = {
  agents: { code: string; label: string; agent_ids: number[]; rubric_version: string }[];
  scorecard: { key: string; label: string; max: number }[];
};

export type Filters = Partial<{
  agent_code: string;
  status: string;
  success: string;
  goal: string;
  needs_review: string;
  failure_code: string;
  min_score: string;
  max_score: string;
  sort: string;
  page: string;
}>;

const qs = (f: Record<string, string | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
};

export const api = {
  list: (f: Filters) => call<{ data: AuditListRow[]; page: number; page_size: number; total: number }>(`/audits${qs(f)}`),
  stats: (f: Filters) => call<{ data: Stats }>(`/audits/stats${qs(f)}`).then((r) => r.data),
  get: (id: number) => call<{ data: AuditDetail }>(`/audits/${id}`).then((r) => r.data),
  recording: (id: number) => call<{ data: { url: string | null; reason?: string } }>(`/audits/${id}/recording`).then((r) => r.data),
  reaudit: (id: number) => call<{ data: AuditDetail }>(`/audits/${id}/reaudit`, { method: "POST" }).then((r) => r.data),
  agents: () => call<{ data: Agents }>(`/agents`).then((r) => r.data),
};

/** Server settings the dashboard needs: `v2_enabled` is AUDIT_V2_ENABLED. */
export type Config = { v2_enabled: boolean };

export const configApi = {
  get: () => call<{ data: Config }>(`/config`).then((r) => r.data),
};

// ---- Calls: every row in voice_call_logs, with its audit when it has one ----

export type CallAuditSummary = Pick<
  AuditListRow,
  "id" | "status" | "skip_reason" | "overall_score" | "success_result" | "goal_result" | "goal_reason_code" | "failure_codes" | "auditor_confidence" | "needs_review" | "rubric_version"
>;

export type CallRow = {
  id: number;
  business_id: number;
  agent_id: number | null;
  agent_code: string | null;
  agent_label: string | null;
  status: string;
  call_type: string | null;
  provider: string | null;
  voice_provider: string | null;
  is_playground: boolean | null;
  duration: number | null;
  ended_reason: string | null;
  created_at: string;
  turns: number;
  has_recording: boolean;
  has_summary: boolean;
  contact_name: string | null;
  audit: CallAuditSummary | null;
};

export type CallStats = {
  total_calls: number;
  calls_by_status: Record<string, number>;
  audited: number;
  avg_score: number | null;
  success_rate: number | null;
  goal_rate: number | null;
  needs_review: number;
  top_failures: { code: string; count: number }[];
};

export type CallFull = AuditCall & {
  agent_id: number | null;
  agent_label: string | null;
  voice_provider: string | null;
  is_playground: boolean;
  phone_number: string | null;
  source_phone_number: string | null;
  provider: string | null;
  provider_call_id: string | null;
  error_detail: Record<string, unknown> | null;
  meta_data: Record<string, unknown> | null;
  tags: string[];
  system_ref_id: string | null;
  conversation_ref: string | null;
  retries: number | null;
  scheduled_at: string | null;
  initiated_at: string | null;
  picked_at: string | null;
  ends_at: string | null;
  updated_at: string | null;
  contact: Record<string, unknown> | null;
  channel: string | null;
  voice: string | null;
};

export type CallDetailData = { call: CallFull; audit: AuditDetail | null };

export type CallFilters = Partial<{
  agent_code: string;
  status: string;
  call_type: string;
  audit: string;
  success: string;
  goal: string;
  needs_review: string;
  failure_code: string;
  search: string;
  sort: string;
  page: string;
}>;

export const callsApi = {
  list: (f: CallFilters) => call<{ data: CallRow[]; page: number; page_size: number; total: number }>(`/calls${qs(f)}`),
  stats: (agent_code?: string) => call<{ data: CallStats }>(`/calls/stats${qs({ agent_code })}`).then((r) => r.data),
  get: (id: number) => call<{ data: CallDetailData }>(`/calls/${id}`).then((r) => r.data),
  recording: (id: number) => call<{ data: { url: string | null; reason?: string } }>(`/calls/${id}/recording`).then((r) => r.data),
  audit: (id: number) => call<{ data: AuditDetail }>(`/calls/${id}/audit`, { method: "POST" }).then((r) => r.data),
};

// ---- Failure conditions (v2, PRD §4.5): the shared library and each scorecard's conditions ----

export type Severity = "critical" | "major" | "minor";
export type LibraryCondition = {
  code: string;
  label: string;
  definition: string;
  default_severity: Severity;
  rolls_up_to: string[];
  detection: "rule" | "llm";
  created_at: string;
};
export type ScorecardCondition = { condition_code: string; enabled: boolean; severity: Severity; metric_key: string | null };
export type ScorecardConditions = {
  scorecard_id: string;
  name: string;
  published: number;
  draft: number | null;
  agents: string[];
  metrics: { key: string; name: string }[];
  conditions: ScorecardCondition[];
  /** What the draft adds or changes; it counts only after Publish. */
  pending: ScorecardCondition[];
};
export type NewCondition = {
  code?: string;
  label: string;
  flags_when: string;
  does_not_count: string;
  severity: Severity;
  metric_key?: string | null;
  scorecards: string[];
};

export const conditionsApi = {
  list: () => call<{ data: { conditions: LibraryCondition[]; scorecards: ScorecardConditions[] } }>(`/conditions`).then((r) => r.data),
  add: (c: NewCondition) => call<{ data: LibraryCondition }>(`/conditions`, { method: "POST", body: JSON.stringify(c) }).then((r) => r.data),
  remove: (code: string) => call(`/conditions/${encodeURIComponent(code)}`, { method: "DELETE" }),
  publish: (scorecardId: string) => call(`/scorecards/${encodeURIComponent(scorecardId)}/publish`, { method: "POST" }),
  discard: (scorecardId: string) => call(`/scorecards/${encodeURIComponent(scorecardId)}/draft`, { method: "DELETE" }),
};

// ---- Scorecard and goal admin (v2, PRD §3.2, §4, §8 #3, §8 #14) ----

export type MetricMethod = "llm" | "rule" | "audio" | "hybrid";
export type ConfigMetric = {
  id: number;
  key: string;
  position: number;
  name: string;
  description: string;
  rubric: { checks: string; anchors: { "0": string; "5": string; "10": string } };
  applicability: string;
  method: MetricMethod;
  weight: number;
  scale: number;
  auto_fail: boolean;
  evidence_required: boolean;
  requires: ("audio" | "timestamps" | "tool_calls")[];
};
export type ScorecardVersion = {
  scorecard_id: string;
  version: number;
  status: "draft" | "published";
  name: string;
  based_on: number | null;
  pass_threshold: number;
  published_at: string | null;
  metrics: ConfigMetric[];
  conditions: ScorecardCondition[];
};
/** One difference between two versions: `metric.<key>.weight`, `condition.<code>.severity`, `reason_codes.PARTIAL`, … */
export type ConfigChange = { field: string; before: unknown; after: unknown };
export type ScorecardAdmin = {
  scorecard_id: string;
  agents: { code: string; label: string }[];
  published: ScorecardVersion;
  draft: (ScorecardVersion & { created_by: string | null; created_at: string }) | null;
  base: number | null;
  changes: ConfigChange[];
  publish_errors: string[];
  library: { code: string; label: string; definition: string; detection: "rule" | "llm"; rolls_up_to: string[]; needs_data: string | null }[];
};
export type ScorecardSummary = {
  scorecard_id: string;
  name: string;
  published: number;
  published_at: string | null;
  draft: number | null;
  draft_changes: number;
  agents: { code: string; label: string }[];
};
export type ScorecardPatch = {
  pass_threshold?: number;
  metrics?: { key: string; name?: string; description?: string; rubric?: { checks?: string; anchors?: Record<string, string> }; applicability?: string; auto_fail?: boolean; weight?: number }[];
  conditions?: { code: string; enabled?: boolean; severity?: Severity; metric_key?: string | null }[];
};
type Verdict = { score: number | null; passed: boolean };
type SimSide = { version: number; passed: number; pass_rate: number | null; average_score: number | null };
export type Simulation = {
  requested: number;
  audits: number;
  before: SimSide;
  after: SimSide;
  flipped: { audit_id: number; call_id: number; before: Verdict; after: Verdict }[];
  score_changed: number;
  unscored: { audits: number; metrics: string[] };
};
export type HistoryEntry = {
  version: number;
  status: "draft" | "published";
  created_by: string | null;
  created_at: string;
  published_at: string | null;
  published_by: string | null;
  changes: ConfigChange[];
  log: { action: "draft_created" | "edited" | "published" | "discarded"; changes: ConfigChange[]; changed_by: string; changed_at: string }[];
};

export type BusinessOutcome = "ACHIEVED" | "PARTIAL" | "NOT_ACHIEVED" | "NOT_APPLICABLE";
export type GoalConfig = {
  agent_code: string;
  version: number;
  status: "draft" | "published";
  name: string;
  description: string;
  success_criteria: string[];
  partial_success: string[];
  not_applicable_when: string[];
  required_outputs: string[];
  reason_codes: Partial<Record<BusinessOutcome, string[]>>;
  system_checks: { silence_limit_s: number; required_variables: string[]; flow_steps: string[] | null };
  published_at: string | null;
};
export type GoalAdmin = {
  agent_code: string;
  label: string;
  published: GoalConfig | null;
  draft: (GoalConfig & { created_by: string | null; created_at: string }) | null;
  changes: ConfigChange[];
  publish_errors: string[];
};
export type GoalSummary = {
  agent_code: string;
  label: string;
  name: string | null;
  published: number | null;
  published_at: string | null;
  draft: number | null;
  draft_changes: number;
};
export type GoalTemplate = { id: string } & Pick<
  GoalConfig,
  "name" | "description" | "success_criteria" | "partial_success" | "not_applicable_when" | "required_outputs" | "reason_codes"
>;
export type GoalPatch = Partial<Pick<GoalConfig, "name" | "description" | "success_criteria" | "partial_success" | "not_applicable_when" | "required_outputs" | "reason_codes">> & {
  system_checks?: { required_variables?: string[]; flow_steps?: string[] | null };
};

const enc = encodeURIComponent;
const json = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });

export const scorecardsApi = {
  list: () => call<{ data: ScorecardSummary[] }>(`/scorecards`).then((r) => r.data),
  get: (id: string) => call<{ data: ScorecardAdmin }>(`/scorecards/${enc(id)}`).then((r) => r.data),
  startDraft: (id: string) => call<{ data: ScorecardAdmin }>(`/scorecards/${enc(id)}/draft`, json("POST")).then((r) => r.data),
  saveDraft: (id: string, patch: ScorecardPatch) => call<{ data: ScorecardAdmin }>(`/scorecards/${enc(id)}/draft`, json("PATCH", patch)).then((r) => r.data),
  publish: (id: string) => call(`/scorecards/${enc(id)}/publish`, json("POST")),
  discard: (id: string) => call(`/scorecards/${enc(id)}/draft`, json("DELETE")),
  simulate: (id: string, n: number) => call<{ data: Simulation }>(`/scorecards/${enc(id)}/simulation?n=${n}`).then((r) => r.data),
  history: (id: string) => call<{ data: HistoryEntry[] }>(`/scorecards/${enc(id)}/history`).then((r) => r.data),
};

export const goalsApi = {
  templates: () => call<{ data: GoalTemplate[] }>(`/goal-templates`).then((r) => r.data),
  list: () => call<{ data: GoalSummary[] }>(`/goals`).then((r) => r.data),
  get: (agent: string) => call<{ data: GoalAdmin }>(`/goals/${enc(agent)}`).then((r) => r.data),
  startDraft: (agent: string, template?: string) => call<{ data: GoalAdmin }>(`/goals/${enc(agent)}/draft`, json("POST", { template })).then((r) => r.data),
  saveDraft: (agent: string, patch: GoalPatch) => call<{ data: GoalAdmin }>(`/goals/${enc(agent)}/draft`, json("PATCH", patch)).then((r) => r.data),
  publish: (agent: string) => call<{ data: GoalAdmin }>(`/goals/${enc(agent)}/publish`, json("POST")).then((r) => r.data),
  discard: (agent: string) => call(`/goals/${enc(agent)}/draft`, json("DELETE")),
  history: (agent: string) => call<{ data: HistoryEntry[] }>(`/goals/${enc(agent)}/history`).then((r) => r.data),
};

// ---- v2 call page, reviews and blind spot-checks (PRD §5; P1-22, P2-1, P2-3, P2-4, P2-18) ----

export type CheckResult = "PASS" | "FAIL" | "NOT_APPLICABLE";
export type CheckCode = "S1" | "S2" | "S3" | "S4";
export type StoredEvidence = { turns: number[]; ts_start: number | null; ts_end: number | null; quote?: string };
export type CheckOutcome = {
  result: CheckResult;
  reason: string;
  evidence: StoredEvidence[];
  rule: { result: CheckResult; reason: string } | null;
  judge: { result: CheckResult; reason: string } | null;
  /** Absent on audits stored before flags failed their check (Open #21, 2026-10-28). */
  flags?: string[];
};
export type MetricOutcome = {
  key: string;
  name: string;
  score: number | null;
  max: number;
  n_a: boolean;
  source: "judge" | "rule" | "unavailable";
  reason: string;
  evidence: StoredEvidence[];
  zeroed_by: string | null;
};
export type FlagRecord = { code: string; source: "rule" | "judge"; severity: Severity; reason: string; evidence: StoredEvidence[] };
export type Sentiment = "positive" | "neutral" | "negative" | "frustrated" | "confused";
export type AuditorNotes = {
  went_well: { point: string; turns: number[] }[];
  improvements: { point: string; suggestion: string; turns: number[]; severity: "low" | "medium" | "high" }[];
  sentiment: { start: Sentiment; end: Sentiment; note: string };
  conclusion: string;
};
export type AuditResultV2 = {
  score: number | null;
  passed: boolean | null;
  failed_by: { kind: string; code?: string; metric?: string }[];
  system_goal: { result: CheckResult; failed: CheckCode[] };
  checks: Record<CheckCode, CheckOutcome>;
  business_goal: {
    outcome: BusinessOutcome;
    reason_code: string;
    reason: string;
    evidence: StoredEvidence[];
    required_outputs: { key: string; value: string | null; turns: number[] }[];
  } | null;
  metrics: MetricOutcome[];
  flags: FlagRecord[];
  weights_used: Record<string, number>;
  call_summary: string | null;
  /** Absent on audits made before judge prompt v2-2. */
  notes?: AuditorNotes | null;
  transcript_quality: "good" | "fair" | "poor" | null;
  auditor_confidence: number;
  needs_review: boolean;
  review_reasons: string[];
  judge: {
    model: string;
    prompt_version: string;
    instructions: { prompt_code: string; version: number } | null;
    evidence_validity: number | null;
  };
};
export type AuditRowV2 = {
  id: number;
  call_id: number;
  agent_code: string | null;
  status: AuditStatus;
  skip_reason: string | null;
  error: string | null;
  score: number | null;
  success_result: "PASS" | "FAIL" | null;
  needs_review: boolean;
  scorecard_id: string | null;
  scorecard_version: number | null;
  goal_version: number | null;
  weights_used: Record<string, number> | null;
  judge_model: string | null;
  judge_prompt_version: string | null;
  triggered_by: string | null;
  trigger_mode: string | null;
  cost: number | null;
  latency_ms: number | null;
  superseded_by: number | null;
  created_at: string;
  audited_at: string | null;
  result: AuditResultV2 | null;
};
export type MetricDefinition = {
  key: string;
  name: string;
  description: string;
  rubric: { checks: string; anchors: { 0: string; 5: string; 10: string } };
  applicability: string;
  method: string;
  weight: number;
  scale: number;
  auto_fail: boolean;
};
export type ConditionView = { code: string; label: string; definition: string; severity: Severity | null; enabled: boolean };
export type AuditContext = {
  scorecard: { scorecard_id: string; version: number; name: string; pass_threshold: number } | null;
  metrics: MetricDefinition[];
  conditions: ConditionView[];
  goal: { name: string; description: string; outcomes: BusinessOutcome[]; reason_codes: Partial<Record<BusinessOutcome, string[]>> } | null;
};
export type AuditHistoryEntry = Pick<
  AuditRowV2,
  | "id"
  | "status"
  | "score"
  | "success_result"
  | "scorecard_id"
  | "scorecard_version"
  | "goal_version"
  | "weights_used"
  | "judge_model"
  | "judge_prompt_version"
  | "triggered_by"
  | "trigger_mode"
  | "superseded_by"
  | "created_at"
  | "audited_at"
> & {
  rescores: {
    id: number;
    score: number | null;
    passed: boolean;
    weights_used: Record<string, number>;
    created_by: string;
    created_at: string;
  }[];
};
export type ReviewVerdict = "agree" | "dispute" | "flag";
export type Review = {
  id: number;
  audit_id: number;
  reviewer: string;
  kind: "normal" | "blind";
  verdict: ReviewVerdict;
  note: string | null;
  item_notes: Record<string, string> | null;
  corrected_scores: Record<string, number | null> | null;
  corrected_checks: Partial<Record<CheckCode, CheckResult>> | null;
  expected_pass_fail: "PASS" | "FAIL" | null;
  expected_business_outcome: BusinessOutcome | null;
  expected_failure_codes: string[] | null;
  created_at: string;
};
export type AuditView = { audit: AuditRowV2; context: AuditContext; history: AuditHistoryEntry[]; reviews: Review[] };
export type ReviewInput = {
  verdict: ReviewVerdict;
  corrected_scores?: Record<string, number | null>;
  corrected_checks?: Partial<Record<CheckCode, CheckResult>>;
  expected_business_outcome?: BusinessOutcome | null;
  expected_failure_codes?: string[] | null;
  item_notes?: Record<string, string>;
  note?: string | null;
};

export const auditV2Api = {
  /** The call's current v2 audit, or null when it has none. */
  forCall: (callId: number) => call<{ data: AuditView | null }>(`/v2/calls/${callId}/audit`).then((r) => r.data),
  get: (auditId: number) => call<{ data: AuditView }>(`/v2/audits/${auditId}`).then((r) => r.data),
  /** Audit this call with v2, at the scorecard's default weights (the sliders come with P1-14). */
  run: (callId: number) => call<{ data: { id: number } }>(`/v2/calls/${callId}/audit`, { method: "POST", body: "{}" }).then((r) => r.data),
  review: (auditId: number, input: ReviewInput) =>
    call<{ data: Review }>(`/v2/audits/${auditId}/reviews`, { method: "POST", body: JSON.stringify(input) }).then((r) => r.data),
};

export type SpotCheckItem = {
  audit_id: number;
  call_id: number;
  agent_code: string;
  call_created_at: string | null;
  duration: number | null;
  done: boolean;
};
export type WeekSample = {
  week_start: string;
  per_agent: number;
  draws: { id: number; seed: number; created_by: string; created_at: string; picked: number }[];
  agents: { agent_code: string; wanted: number; picked: number; items: SpotCheckItem[] }[];
  shortfall: { agent_code: string; available: number; wanted: number }[];
  can_top_up: number;
};
export type BlindAnswer = {
  expected_pass_fail: "PASS" | "FAIL";
  expected_business_outcome: BusinessOutcome;
  expected_failure_codes: string[];
  note?: string | null;
};
export type BlindItem = {
  audit_id: number;
  call_id: number;
  agent_code: string | null;
  call: { call_type: string | null; duration: number | null; call_created_at: string | null; has_recording: boolean; transcript: Turn[] };
  options: { outcomes: BusinessOutcome[]; failure_codes: { code: string; label: string; definition: string }[] };
  revealed: null | {
    review: Review;
    judge: {
      pass_fail: "PASS" | "FAIL" | null;
      business_outcome: BusinessOutcome | null;
      failure_codes: string[];
      score: number | null;
      reason_code: string | null;
    };
    comparison: { pass_fail: boolean; business_outcome: boolean; failure_codes: boolean; agree: boolean };
  };
};

export const spotCheckApi = {
  week: (week?: string) => call<{ data: WeekSample }>(`/v2/spot-checks${qs({ week })}`).then((r) => r.data),
  topUp: (week: string) => call<{ data: WeekSample }>(`/v2/spot-checks/top-up${qs({ week })}`, { method: "POST" }).then((r) => r.data),
  item: (auditId: number) => call<{ data: BlindItem }>(`/v2/spot-checks/items/${auditId}`).then((r) => r.data),
  save: (auditId: number, answer: BlindAnswer) =>
    call<{ data: BlindItem }>(`/v2/spot-checks/items/${auditId}`, { method: "POST", body: JSON.stringify(answer) }).then((r) => r.data),
};

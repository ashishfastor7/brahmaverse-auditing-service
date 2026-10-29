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

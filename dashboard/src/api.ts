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
export type Metric = { applicable: boolean; score: number | null; reasoning: string; evidence: Evidence[] };
export type Failure = { code: string; source: "rule" | "llm"; explanation: string; turn: number | null; quote: string | null };
export type Turn = { turn: number; speaker: string; text: string };

export type AuditResult = {
  overall_score: number | null;
  quality_score: number | null;
  call_success: { result: "PASS" | "FAIL"; failure_reasons: Failure[] };
  call_goal: { result: "ACHIEVED" | "NOT_ACHIEVED" | "NOT_APPLICABLE"; reason_code: string; explanation: string; evidence: Evidence[] };
  metrics: Record<string, Metric>;
  went_well: { point: string; turn: number; quote: string; valid?: boolean }[];
  went_wrong: { point: string; turn: number; quote: string; severity: "low" | "medium" | "high"; valid?: boolean }[];
  sentiment: { start: string; end: string; note: string };
  verdict: string;
  auditor_confidence: number;
  needs_review: boolean;
  rubric_version: string;
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

export type Rubric = {
  version: string;
  agent_label: string;
  agent_codes: string[];
  dimensions: { key: string; label: string; weight: number }[];
  failure_conditions: { code: string; label: string }[];
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

const qs = (f: Filters) => {
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
  rubrics: () => call<{ data: Rubric[] }>(`/rubrics`).then((r) => r.data),
};

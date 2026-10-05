import { request } from "./bus";

/**
 * Lists finished calls from integration-service's existing `query.voicecall.list` RPC, for
 * auditing calls that ended before the `voicecall.ended` event existed.
 */
export async function listCalls(params: {
  business_id: number;
  agent_id?: number;
  date_range?: { from: string; to: string };
}): Promise<any[]> {
  return (await request<any[]>("query.voicecall.list", { ...params, status: "completed" }, 60_000)) ?? [];
}

/**
 * A playable url for a call's recording, from integration-service's `query.voicecall.recording-url`
 * (added by patches/integration-service-voicecall-ended.patch). Stored urls point at a private
 * bucket, so they can't be played directly.
 */
export async function recordingUrl(call_id: number, business_id: number): Promise<string | null> {
  const res = await request<{ url: string | null }>("query.voicecall.recording-url", { id: call_id, business_id });
  return res?.url ?? null;
}

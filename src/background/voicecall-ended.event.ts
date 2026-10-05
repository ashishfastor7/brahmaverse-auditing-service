import { normalizeCall } from "@/audit/normalize";
import { runAudit } from "@/audit/run-audit";
import { getBus } from "@/services/bus";

export const VOICECALL_ENDED_SUBJECT = "voicecall.ended";

/**
 * Audits every call integration-service finalizes. JetStream keeps the events, so calls that end
 * while this service is down are audited when it comes back. A judge failure throws, which naks
 * the message for a retry (3 deliveries); `runAudit` is idempotent, so redelivery is safe.
 */
export async function subscribeToCallEnded() {
  const { subscribe } = await getBus();
  await subscribe(
    VOICECALL_ENDED_SUBJECT,
    async (payload: any) => {
      await runAudit(normalizeCall(payload));
    },
    // max_wait is the ack deadline per delivery (ms): the judge can take a minute on long calls.
    { groupId: "auditing-service", concurrency: 2, retries: 3, max_wait: 240_000 },
  );
  console.log(`subscribed to ${VOICECALL_ENDED_SUBJECT}`);
}

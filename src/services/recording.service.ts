import { env } from "@/env";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { isNoResponders } from "./bus";
import { recordingUrl as recordingUrlViaRpc } from "./call-source.service";

/**
 * A playable url for a call's recording. Recordings sit in a private bucket
 * (`https://<bucket>.s3.amazonaws.com/private/<business_id>/recodings/...`): with AWS credentials
 * configured the url is presigned here; otherwise integration-service is asked over the bus.
 */
export async function playableRecordingUrl(call: { call_id: number; business_id: number; recording_url: string | null }) {
  if (!call.recording_url) return { url: null, reason: "this call has no recording" };

  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
    const parsed = parseBucketUrl(call.recording_url);
    if (!parsed) return { url: null, reason: "unrecognised recording url" };
    // Same ownership rule as integration-service: a private key must belong to the call's business.
    if (parsed.key.startsWith("private/") && !parsed.key.startsWith(`private/${call.business_id}/`)) {
      return { url: null, reason: "recording belongs to another business" };
    }
    const s3 = new S3Client({
      region: env.AWS_REGION,
      credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY },
    });
    // Archived recordings were stored with a form-urlencoded content type, which browsers may refuse
    // to play; the signed url asks S3 to serve them as audio instead (they are WAV files).
    const command = new GetObjectCommand({ Bucket: parsed.bucket, Key: parsed.key, ResponseContentType: "audio/wav" });
    return { url: await getSignedUrl(s3, command, { expiresIn: 3600 }) };
  }

  try {
    return { url: await recordingUrlViaRpc(call.call_id, call.business_id) };
  } catch (e) {
    return { url: null, reason: isNoResponders(e) ? "integration-service has no recording-url handler yet" : (e as Error).message };
  }
}

/** `https://bucket.s3[.region].amazonaws.com/key` → { bucket, key } */
export function parseBucketUrl(url: string): { bucket: string; key: string } | null {
  try {
    const u = new URL(url);
    const m = u.hostname.match(/^(.+?)\.s3[.-]?([a-z0-9-]*)\.amazonaws\.com$/);
    if (!m) return null;
    return { bucket: m[1], key: decodeURIComponent(u.pathname.replace(/^\//, "")) };
  } catch {
    return null;
  }
}

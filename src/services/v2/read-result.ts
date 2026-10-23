/**
 * What a v2 reader of another service's data returns. A missing login, a missing row or a failed query is a
 * `reason`, never a thrown error: the audit goes on without that data.
 */
export type ReadReason = "not_configured" | "not_applicable" | "not_found" | "query_failed";
export type Unavailable = { value: null; reason: ReadReason; detail: string };
export type ReadResult<T> = { value: T; reason: null } | Unavailable;

export const found = <T>(value: T): ReadResult<T> => ({ value, reason: null });
export const unavailable = (reason: ReadReason, detail: string): Unavailable => ({ value: null, reason, detail });

/** Runs a reader; a thrown error (connection, timeout, bad SQL) becomes `query_failed` instead of failing the audit. */
export async function guard<T>(label: string, read: () => Promise<ReadResult<T>>): Promise<ReadResult<T>> {
  try {
    return await read();
  } catch (e) {
    const detail = (e as Error).message;
    console.warn(`[${label}] read failed (${detail}); auditing without it`);
    return unavailable("query_failed", detail);
  }
}

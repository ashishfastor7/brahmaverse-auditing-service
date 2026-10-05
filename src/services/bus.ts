/**
 * The message bus, imported on first use: it connects to NATS as a side effect, and the API,
 * tests and file-based replay must work without it.
 */
let bus: Promise<typeof import("@fastor7/message-bus")> | null = null;
export const getBus = () => (bus ??= import("@fastor7/message-bus"));

/** "no responders" means the service that answers this subject isn't running or lacks the handler. */
export const isNoResponders = (e: unknown) => /no responders/i.test(String((e as Error)?.message ?? e));

export async function request<T>(subject: `query.${string}`, payload: unknown, timeoutMs = 10_000): Promise<T> {
  const { rpc } = await getBus();
  return (await rpc.request(subject, payload, { retries: 1, timeout: timeoutMs })) as T;
}

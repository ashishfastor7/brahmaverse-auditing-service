/**
 * Counts failed sign-ins per client in a fixed window; `blocked` once a client reaches `max` failures, until the
 * window ends. In memory: it resets when the service restarts, which is enough for one admin login.
 */
export function loginThrottle({ max = 10, windowMs = 15 * 60_000, now = () => Date.now() } = {}) {
  const failures = new Map<string, { count: number; resetAt: number }>();
  const current = (key: string) => {
    const entry = failures.get(key);
    if (entry && entry.resetAt <= now()) failures.delete(key);
    return failures.get(key);
  };
  return {
    /** Seconds until this client may try again, or 0 when it isn't blocked. */
    blocked(key: string) {
      const entry = current(key);
      return entry && entry.count >= max ? Math.ceil((entry.resetAt - now()) / 1000) : 0;
    },
    fail(key: string) {
      // Many different clients failing (a spray from many addresses): drop the finished windows so memory stays bounded.
      if (failures.size >= 10_000) for (const [k, e] of failures) if (e.resetAt <= now()) failures.delete(k);
      const entry = current(key) ?? { count: 0, resetAt: now() + windowMs };
      entry.count += 1;
      failures.set(key, entry);
    },
    succeed(key: string) {
      failures.delete(key);
    },
  };
}

export type LoginThrottle = ReturnType<typeof loginThrottle>;

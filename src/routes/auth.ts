import type { CredentialCheck } from "@/auth/credentials";
import { hashToken, newToken, type SessionStore } from "@/auth/session-store";
import type { LoginThrottle } from "@/auth/throttle";
import { type AuthEnv, bearerToken, requireSession, signedInUser } from "@/middleware/auth";
import { Hono, type Context } from "hono";
import { getConnInfo } from "hono/bun";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

const credentials = z.object({ username: z.string().max(200), password: z.string().max(200) });

export type AuthDeps = {
  store: SessionStore;
  check: CredentialCheck;
  throttle: LoginThrottle;
  sessionHours: number;
  now?: () => Date;
};

/** The client's address for the throttle; requests without a socket (tests) share one key. */
function clientKey(c: Context) {
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Sign-in for the dashboard: one admin username/password (no roles; everyone signed in can do everything).
 * - `POST /auth/login` with `{ username, password }` → `{ data: { token, username, expires_at } }`; 401 for wrong
 *   credentials (the same message whichever was wrong), 429 after too many failures from one client.
 * - `POST /auth/logout` ends the session; `GET /auth/me` returns who is signed in. Both need the session.
 * Mounted before the app's session middleware, so login stays public. Takes its store, check, throttle and clock so
 * tests can pass their own.
 */
export function authRouter({ store, check, throttle, sessionHours, now = () => new Date() }: AuthDeps) {
  const router = new Hono<AuthEnv>();
  const session = requireSession(store, now);

  router.post("/auth/login", async (c) => {
    const key = clientKey(c);
    const wait = throttle.blocked(key);
    if (wait) {
      c.header("Retry-After", String(wait));
      throw new HTTPException(429, { message: "Too many sign-in attempts. Try again later." });
    }
    const parsed = credentials.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success || !(await check(parsed.data.username, parsed.data.password))) {
      throttle.fail(key);
      throw new HTTPException(401, { message: "Wrong username or password" });
    }
    throttle.succeed(key);
    const at = now();
    await store.deleteExpired(at);
    const { token, hash } = newToken();
    const expires_at = new Date(at.getTime() + sessionHours * 3_600_000);
    await store.create(hash, { username: parsed.data.username, expires_at });
    return c.json({ data: { token, username: parsed.data.username, expires_at } });
  });

  router.post("/auth/logout", session, async (c) => {
    await store.delete(hashToken(bearerToken(c)));
    return c.json({ data: null });
  });

  router.get("/auth/me", session, (c) => c.json({ data: { username: signedInUser(c) } }));
  return router;
}

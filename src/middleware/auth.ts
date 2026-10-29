import { hashToken, type SessionStore } from "@/auth/session-store";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";

/** What `requireSession` adds to the request: the signed-in username. */
export type AuthEnv = { Variables: { username: string } };

/** The session token from `Authorization: Bearer <token>`, or "" when there is none. */
export const bearerToken = (c: Context) => {
  const header = c.req.header("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
};

/**
 * Every `/v1/audit/*` route except health and sign-in needs a session from `POST /auth/login`. A missing, unknown or
 * expired token gets 401; an expired session is deleted when it's seen.
 */
export function requireSession(store: SessionStore, now: () => Date = () => new Date()): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const token = bearerToken(c);
    const hash = token ? hashToken(token) : "";
    const session = hash ? await store.find(hash) : null;
    if (!session) throw new HTTPException(401, { message: "Unauthorized" });
    if (session.expires_at <= now()) {
      await store.delete(hash);
      throw new HTTPException(401, { message: "Unauthorized" });
    }
    c.set("username", session.username);
    await next();
  };
}

/** The signed-in username, recorded as `triggered_by` / `created_by`. 401 if a route is reached without a session. */
export function signedInUser(c: Context<AuthEnv>) {
  const username = c.get("username");
  if (!username) throw new HTTPException(401, { message: "Unauthorized" });
  return username;
}

import { env } from "@/env";
import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { timingSafeEqual } from "node:crypto";

/**
 * A single shared bearer token for the internal dashboard. Enough while only Fastor7 staff use it;
 * per-business access (the existing user JWTs) comes with exposing audits to customers.
 */
export const requireToken: MiddlewareHandler = async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const expected = Buffer.from(env.AUDIT_API_TOKEN);
  const received = Buffer.from(token);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }
  await next();
};

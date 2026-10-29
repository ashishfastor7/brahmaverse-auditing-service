import { sequelize } from "@/db/connection";
import { env } from "@/env";
import { requireToken } from "@/middleware/auth";
import { auditV2Router } from "@/routes/audit-v2";
import audits from "@/routes/audits";
import calls from "@/routes/calls";
import { conditionsRouter } from "@/routes/conditions";
import config from "@/routes/config";
import { rescoreRouter } from "@/routes/rescore";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { ZodError } from "zod";

/** The HTTP API, without starting anything: `index.ts` serves it, tests call `app.request`. */
export const app = new Hono();
app.use(cors({ origin: "*", maxAge: 3600 }));
app.use(logger());

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ status: false, message: err.message }, err.status);
  if (err instanceof ZodError) return c.json({ status: false, message: "Invalid request", issues: err.issues }, 400);
  console.error(err);
  return c.json({ status: false, message: "Something went wrong" }, 500);
});

app.get("/v1/audit/health", (c) => c.json({ status: true }));
app.use("/v1/audit/*", requireToken);
app.route("/v1/audit", audits);
app.route("/v1/audit", calls);
app.route("/v1/audit", config);
app.route(
  "/v1/audit",
  rescoreRouter(
    () => sequelize,
    () => env.AUDIT_V2_ENABLED,
  ),
);
app.route(
  "/v1/audit",
  conditionsRouter(
    () => sequelize,
    () => env.AUDIT_V2_ENABLED,
  ),
);
app.route(
  "/v1/audit",
  auditV2Router(
    () => sequelize,
    () => env.AUDIT_V2_ENABLED,
  ),
);

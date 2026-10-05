import { startSyncJob } from "@/background/sync.job";
import { subscribeToCallEnded } from "@/background/voicecall-ended.event";
import { sequelize } from "@/db";
import { env } from "@/env";
import { requireToken } from "@/middleware/auth";
import audits from "@/routes/audits";
import calls from "@/routes/calls";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { ZodError } from "zod";

const app = new Hono();
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

await sequelize.authenticate();
console.log("database connected");

if (env.AUDIT_SUBSCRIBE) {
  subscribeToCallEnded().catch((e) => console.error("could not subscribe to voicecall.ended:", e.message));
}

if (env.AUDIT_SYNC_ENABLED) startSyncJob();

export default { port: env.PORT, fetch: app.fetch };
console.log(`auditing service on :${env.PORT}`);

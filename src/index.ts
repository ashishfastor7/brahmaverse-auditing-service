import { app } from "@/app";
import { startSyncJob } from "@/background/sync.job";
import { subscribeToCallEnded } from "@/background/voicecall-ended.event";
import { sequelize } from "@/db";
import { pendingMigrations } from "@/db/migrator";
import { env } from "@/env";

// admin / password is for local dev; never serve real call data behind it.
if (env.AUDIT_ADMIN_PASSWORD === "password") {
  if (process.env.NODE_ENV === "production") {
    console.error("AUDIT_ADMIN_PASSWORD is still the default. Set a real password in .env, then start again.");
    process.exit(1);
  }
  console.warn("warning: the dashboard sign-in uses the default password (local dev only). Set AUDIT_ADMIN_PASSWORD in .env.");
}

await sequelize.authenticate();
console.log("database connected");

// Migrations never run on startup; refuse to serve against a schema older than the code.
const pending = await pendingMigrations(sequelize);
if (pending.length) {
  console.error(`pending migrations: ${pending.join(", ")}. Run \`bun run migrate\`, then start again.`);
  process.exit(1);
}

if (env.AUDIT_SUBSCRIBE) {
  subscribeToCallEnded().catch((e) => console.error("could not subscribe to voicecall.ended:", e.message));
}

if (env.AUDIT_SYNC_ENABLED) startSyncJob();

// An on-demand audit holds the request open for the judge call (~15–30 s). Bun closes connections
// idle for 10 s by default, which the browser reports as "Failed to fetch"; 255 s is Bun's maximum.
export default { port: env.PORT, fetch: app.fetch, idleTimeout: 255 };
console.log(`auditing service on :${env.PORT}`);

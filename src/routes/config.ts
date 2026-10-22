import { env } from "@/env";
import { Hono } from "hono";

/** Server settings the dashboard needs. `v2_enabled` is AUDIT_V2_ENABLED: off, the dashboard shows only v1. */
const router = new Hono();

router.get("/config", (c) => c.json({ data: { v2_enabled: env.AUDIT_V2_ENABLED } }));

export default router;

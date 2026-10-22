import { createEnv } from "@t3-oss/env-core";
import "dotenv/config";
import { z } from "zod";

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? fallback : v === "true"));

export const env = createEnv({
  server: {
    DB_HOSTNAME: z.string().default("localhost"),
    DB_PORT: z.coerce.number().default(5432),
    DB_USERNAME: z.string().default("postgres"),
    DB_PASSWORD: z.string().default(""),
    DB_NAME: z.string().default("brahmaverse_audit"),
    DB_SSL: bool(false),

    // Read-only access to integration-service's voice_call_logs (replay --db, sync job)
    SOURCE_DB_HOSTNAME: z.string().optional(),
    SOURCE_DB_PORT: z.coerce.number().default(5432),
    SOURCE_DB_USERNAME: z.string().optional(),
    SOURCE_DB_PASSWORD: z.string().default(""),
    SOURCE_DB_NAME: z.string().default("brainey-integration"),
    SOURCE_DB_SSL: bool(true),

    // Recording playback: presign recordings in the private bucket
    AWS_ACCESS_KEY_ID: z.string().optional(),
    AWS_SECRET_ACCESS_KEY: z.string().optional(),
    AWS_REGION: z.string().default("ap-south-1"),

    OPENAI_API_KEY: z.string().optional(),
    AUDIT_JUDGE_MODEL: z.string().default("gpt-5.6-luna"),
    AUDIT_JUDGE_REASONING_EFFORT: z
      .enum(["minimal", "low", "medium", "high", ""])
      .optional()
      .transform((v) => v || undefined),

    PORT: z.coerce.number().default(8095),
    AUDIT_API_TOKEN: z.string().min(1).default("change-me"),
    AUDIT_SUBSCRIBE: bool(true),
    AUDIT_INCLUDE_PLAYGROUND: bool(false),
    AUDIT_REVIEW_THRESHOLD: z.coerce.number().min(0).max(1).default(0.7),

    // Sync job: polls voice_call_logs for newly ended calls and audits them (each audit is an LLM call)
    AUDIT_SYNC_ENABLED: bool(false),
    AUDIT_SYNC_INTERVAL_MINUTES: z.coerce.number().min(1).default(5),
    AUDIT_SYNC_AGENT_IDS: z
      .string()
      .optional()
      .transform((v) => (v ? v.split(",").map((x) => Number(x.trim())).filter(Number.isFinite) : [])),
    AUDIT_SYNC_LOOKBACK_HOURS: z.coerce.number().min(1).default(24),
    AUDIT_SYNC_MAX_PER_RUN: z.coerce.number().int().min(1).default(20),

    // `bun run test:db` sets this: *.db.test.ts create and drop throwaway databases on the DB_* server
    AUDIT_TEST_DB: bool(false),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: false,
});

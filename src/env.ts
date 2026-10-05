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
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: false,
});

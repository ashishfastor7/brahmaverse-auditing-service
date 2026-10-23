import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The env defaults, read in a fresh process from an empty directory (so no .env is loaded) with none of the
 * variables set: what a server gets when its config leaves them out.
 */
function defaults(keys: string[]): Record<string, unknown> {
  const dir = mkdtempSync(join(tmpdir(), "audit-env-"));
  try {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !keys.includes(k)));
    const script = `const { env } = await import(${JSON.stringify(join(import.meta.dir, "env.ts"))});
      console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map((k) => [k, env[k] ?? null]))));`;
    const run = Bun.spawnSync([process.execPath, "-e", script], { cwd: dir, env: clean });
    expect(run.exitCode).toBe(0);
    return JSON.parse(run.stdout.toString());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("env defaults", () => {
  it("never audits on its own: no voicecall.ended subscriber and no sync job unless switched on", () => {
    expect(defaults(["AUDIT_SUBSCRIBE", "AUDIT_SYNC_ENABLED"])).toEqual({ AUDIT_SUBSCRIBE: false, AUDIT_SYNC_ENABLED: false });
  });

  it("leaves the ai-service and Vajra logins unset, so v2 readers report not_configured", () => {
    const keys = [
      "AI_DB_HOSTNAME",
      "AI_DB_USERNAME",
      "AI_DB_NAME",
      "AI_DB_PORT",
      "AI_DB_SSL",
      "VAJRA_DB_HOSTNAME",
      "VAJRA_DB_NAME",
      "VAJRA_DB_SSL",
    ];
    expect(defaults(keys)).toEqual({
      AI_DB_HOSTNAME: null,
      AI_DB_USERNAME: null,
      AI_DB_NAME: null,
      AI_DB_PORT: 5432,
      AI_DB_SSL: true,
      VAJRA_DB_HOSTNAME: null,
      VAJRA_DB_NAME: null,
      VAJRA_DB_SSL: true,
    });
  });
});

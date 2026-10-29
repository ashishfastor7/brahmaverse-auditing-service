import type { Judge, JudgeCall, JudgeResponse } from "@/audit/audit-call";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type CacheStats = { hits: number; misses: number };
type CacheFile = { key: string; entries: { request: string; response: JudgeResponse; cached_at: string }[] };

/** The cache key of one judge request: everything that changes its answer (model, messages, schema). */
export const requestHash = (model: string, call: JudgeCall) =>
  createHash("sha256")
    .update(JSON.stringify({ model, messages: call.messages, schema: call.schema }))
    .digest("hex");

/**
 * A judge that answers from `<dir>/<key>.json` when it has seen exactly this request before, and otherwise asks `inner`
 * and stores the answer (P1-19: re-running unchanged calls doesn't re-bill). `dir` is per judge prompt version and `key`
 * per call; a retry is its own request, so it is cached too. A changed rubric, reader or model is a new request.
 * The files hold judge answers with quotes from the call: keep them under eval-output/ (gitignored).
 */
export function cachedJudge(inner: Judge, opts: { dir: string; key: string; model: string; stats: CacheStats }): Judge {
  if (!/^[a-z0-9-]+$/i.test(opts.key)) throw new Error(`bad cache key "${opts.key}"`);
  const file = join(opts.dir, `${opts.key}.json`);
  const load = (): CacheFile => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { key: opts.key, entries: [] });
  return async (call) => {
    const request = requestHash(opts.model, call);
    const hit = load().entries.find((e) => e.request === request);
    if (hit) {
      opts.stats.hits++;
      return structuredClone(hit.response);
    }
    const response = await inner(call);
    opts.stats.misses++;
    const cache = load();
    cache.entries = [...cache.entries.filter((e) => e.request !== request), { request, response, cached_at: new Date().toISOString() }];
    mkdirSync(opts.dir, { recursive: true });
    writeFileSync(file, `${JSON.stringify(cache, null, 2)}\n`);
    return structuredClone(response);
  };
}

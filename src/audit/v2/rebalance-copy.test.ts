import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The dashboard's weight sliders run `dashboard/src/lib/rebalance.ts`, a verbatim copy of `rebalance.ts`, so the dashboard
 * builds on its own (it doesn't reach into ../src). The copy must not drift from the engine's rules.
 */
describe("dashboard copy of rebalanceWeights", () => {
  it("is identical to src/audit/v2/rebalance.ts", () => {
    const read = (path: string) => readFileSync(join(import.meta.dir, path), "utf8").replaceAll("\r\n", "\n");
    expect(read("../../../dashboard/src/lib/rebalance.ts")).toBe(read("rebalance.ts"));
  });
});

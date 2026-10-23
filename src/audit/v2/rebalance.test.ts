import { describe, expect, it } from "bun:test";
import { type Weight, rebalanceWeights } from "./rebalance";

/** The PRD §4.3 metrics in scorecard order, every one at 10. */
const PRD_KEYS = [
  "flow_adherence",
  "query_handling",
  "troubleshooting",
  "communication_tone",
  "opening_closure",
  "language_match",
  "repetition",
  "stalling_filler",
  "interruptions",
  "pronunciation_numbers",
];
const prd = (): Weight[] => PRD_KEYS.map((key) => ({ key, weight: 10 }));
const asMap = (weights: Weight[]) => Object.fromEntries(weights.map((w) => [w.key, w.weight]));
const tenths = (weights: Weight[]) => weights.reduce((sum, w) => sum + Math.round(w.weight * 10), 0);

describe("rebalanceWeights (PRD §4.4)", () => {
  it("Flow adherence 10 → 18 with Language match locked: the other eight absorb 1 point each", () => {
    const out = rebalanceWeights(prd(), ["language_match"], "flow_adherence", 18);
    expect(asMap(out)).toEqual({
      flow_adherence: 18,
      query_handling: 9,
      troubleshooting: 9,
      communication_tone: 9,
      opening_closure: 9,
      language_match: 10,
      repetition: 9,
      stalling_filler: 9,
      interruptions: 9,
      pronunciation_numbers: 9,
    });
    expect(tenths(out)).toBe(1000);
  });

  it("Flow adherence 10 → 20: 8.75 each, the 0.4 left over goes to the first four listed", () => {
    const out = rebalanceWeights(prd(), ["language_match"], "flow_adherence", 20);
    expect(asMap(out)).toEqual({
      flow_adherence: 20,
      query_handling: 8.8,
      troubleshooting: 8.8,
      communication_tone: 8.8,
      opening_closure: 8.8,
      language_match: 10,
      repetition: 8.7,
      stalling_filler: 8.7,
      interruptions: 8.7,
      pronunciation_numbers: 8.7,
    });
    expect(tenths(out)).toBe(1000);
  });

  it("the review meeting's 11 metrics: Flow adherence 12 → 22 gives 8.7 / 7.0 / 4.4", () => {
    const meeting: Weight[] = [
      { key: "flow_adherence", weight: 12 },
      { key: "query_handling", weight: 10 },
      { key: "troubleshooting", weight: 10 },
      { key: "communication_tone", weight: 10 },
      { key: "opening_closure", weight: 8 },
      { key: "language_match", weight: 10 },
      { key: "repetition", weight: 10 },
      { key: "stalling", weight: 5 },
      { key: "filler", weight: 5 },
      { key: "interruptions", weight: 10 },
      { key: "pronunciation_numbers", weight: 10 },
    ];
    const out = rebalanceWeights(meeting, ["language_match"], "flow_adherence", 22);
    expect(asMap(out)).toEqual({
      flow_adherence: 22,
      query_handling: 8.7,
      troubleshooting: 8.7,
      communication_tone: 8.7,
      opening_closure: 7,
      language_match: 10,
      repetition: 8.7,
      stalling: 4.4,
      filler: 4.4,
      interruptions: 8.7,
      pronunciation_numbers: 8.7,
    });
    expect(tenths(out)).toBe(1000);
  });

  it("keeps the input order and doesn't change the input", () => {
    const input = prd();
    const out = rebalanceWeights(input, [], "repetition", 30);
    expect(out.map((w) => w.key)).toEqual(PRD_KEYS);
    expect(input.every((w) => w.weight === 10)).toBe(true);
  });

  it("everything else locked: nothing moves", () => {
    const others = PRD_KEYS.filter((k) => k !== "flow_adherence");
    expect(rebalanceWeights(prd(), others, "flow_adherence", 40)).toEqual(prd());
  });

  it("drag to 0: the others share its weight in proportion", () => {
    const out = rebalanceWeights(prd(), ["language_match"], "flow_adherence", 0);
    const map = asMap(out);
    expect(map.flow_adherence).toBe(0);
    expect(map.language_match).toBe(10);
    // 90 over eight: 11.25 each, so four get 11.3 and four 11.2.
    expect(out.filter((w) => !["flow_adherence", "language_match"].includes(w.key)).map((w) => w.weight)).toEqual([
      11.3, 11.3, 11.3, 11.3, 11.2, 11.2, 11.2, 11.2,
    ]);
    expect(tenths(out)).toBe(1000);
  });

  it("drag to max (and past it): capped at 100 minus the locked total, the other unlocked go to 0", () => {
    for (const value of [90, 150]) {
      const map = asMap(rebalanceWeights(prd(), ["language_match"], "flow_adherence", value));
      expect(map.flow_adherence).toBe(90);
      expect(map.language_match).toBe(10);
      expect(PRD_KEYS.filter((k) => !["flow_adherence", "language_match"].includes(k)).every((k) => map[k] === 0)).toBe(true);
    }
  });

  it("a negative value is 0; the value is rounded to one decimal", () => {
    expect(asMap(rebalanceWeights(prd(), [], "flow_adherence", -5)).flow_adherence).toBe(0);
    expect(asMap(rebalanceWeights(prd(), [], "flow_adherence", 12.34)).flow_adherence).toBe(12.3);
  });

  it("dragging down when every other unlocked metric is at 0 splits the freed weight equally", () => {
    const weights: Weight[] = [
      { key: "a", weight: 70 },
      { key: "b", weight: 0 },
      { key: "c", weight: 0 },
      { key: "d", weight: 30 },
    ];
    expect(rebalanceWeights(weights, ["d"], "a", 60)).toEqual([
      { key: "a", weight: 60 },
      { key: "b", weight: 5 },
      { key: "c", weight: 5 },
      { key: "d", weight: 30 },
    ]);
  });

  it("a metric at 0 stays at 0 while the others absorb", () => {
    const weights: Weight[] = [
      { key: "a", weight: 20 },
      { key: "b", weight: 0 },
      { key: "c", weight: 40 },
      { key: "d", weight: 40 },
    ];
    expect(asMap(rebalanceWeights(weights, [], "a", 40))).toEqual({ a: 40, b: 0, c: 30, d: 30 });
    expect(asMap(rebalanceWeights(weights, [], "a", 0))).toEqual({ a: 0, b: 0, c: 50, d: 50 });
  });

  it("refuses an unknown or locked metric and weights that don't total 100", () => {
    expect(() => rebalanceWeights(prd(), [], "nope", 10)).toThrow("unknown metric nope");
    expect(() => rebalanceWeights(prd(), ["flow_adherence"], "flow_adherence", 10)).toThrow("flow_adherence is locked");
    expect(() => rebalanceWeights([{ key: "a", weight: 60 }], [], "a", 10)).toThrow("weights total 60, not 100");
  });

  it("property: any move keeps the total at exactly 100.0, never goes negative, and never moves a locked metric", () => {
    // Seeded so a failure is reproducible (mulberry32).
    let seed = 20261023;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const int = (n: number) => Math.floor(random() * n);

    for (let run = 0; run < 2000; run++) {
      const n = 2 + int(11);
      // Random tenths totalling 1000: n − 1 cut points on [0, 1000], some metrics may get 0.
      const cuts = [0, ...Array.from({ length: n - 1 }, () => int(1001)), 1000].sort((a, b) => a - b);
      const weights: Weight[] = Array.from({ length: n }, (_, i) => ({ key: `m${i}`, weight: (cuts[i + 1]! - cuts[i]!) / 10 }));
      const changed = weights[int(n)]!.key;
      const locked = weights.filter((w) => w.key !== changed && random() < 0.3).map((w) => w.key);
      const value = Math.round((random() * 140 - 20) * 100) / 100;

      const out = rebalanceWeights(weights, locked, changed, value);
      const context = JSON.stringify({ weights, locked, changed, value, out });
      expect(tenths(out), context).toBe(1000);
      expect(
        out.every((w) => w.weight >= 0 && Math.round(w.weight * 10) === w.weight * 10),
        context,
      ).toBe(true);
      for (const key of locked) expect(asMap(out)[key], context).toBe(asMap(weights)[key]!);
      const lockedTotal = weights.filter((w) => locked.includes(w.key)).reduce((s, w) => s + Math.round(w.weight * 10), 0);
      const othersUnlocked = weights.some((w) => w.key !== changed && !locked.includes(w.key));
      const expected = othersUnlocked ? Math.min(Math.max(Math.round(value * 10), 0), 1000 - lockedTotal) / 10 : asMap(weights)[changed];
      expect(asMap(out)[changed], context).toBe(expected!);
    }
  });
});

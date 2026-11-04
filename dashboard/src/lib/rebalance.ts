/** One slider: a metric's weight (0–100, one decimal). A list of them is in scorecard order and totals 100. */
export type Weight = { key: string; weight: number };

const EPSILON = 1e-9;

/**
 * P0-7, PRD §4.4: moves one weight slider and rebalances the others. Pure; returns a new list in the same order.
 *
 * 1. `changed` goes to `value`, clamped to 0 … (100 − the locked total) and rounded to one decimal.
 * 2. Locked metrics never move. If every other metric is locked, nothing moves.
 * 3. The other unlocked metrics absorb the change in proportion to their current weights. Scaling them all by the
 *    same factor can't take one below 0 (the cap in 1 keeps the change within their total), so rule 4's spill-over
 *    never has anything to spread. If they are all at 0 and gain weight, they split it equally.
 * 4. They are rounded to one decimal so the total is exactly 100.0: leftover tenths go to the largest rounding
 *    remainders, ties to the metric listed first.
 *
 * Works in integer tenths, so the total is exact.
 */
export function rebalanceWeights(weights: Weight[], locked: string[], changed: string, value: number): Weight[] {
  const tenths = weights.map((w) => Math.round(w.weight * 10));
  const total = tenths.reduce((sum, t) => sum + t, 0);
  if (total !== 1000) throw new Error(`weights total ${total / 10}, not 100`);
  const index = weights.findIndex((w) => w.key === changed);
  if (index < 0) throw new Error(`unknown metric ${changed}`);
  if (locked.includes(changed)) throw new Error(`${changed} is locked`);

  const isLocked = weights.map((w) => locked.includes(w.key));
  const others = weights.map((_, i) => i).filter((i) => i !== index && !isLocked[i]);
  if (others.length === 0) return weights.map((w, i) => ({ key: w.key, weight: tenths[i]! / 10 }));

  const lockedTotal = tenths.reduce((sum, t, i) => sum + (isLocked[i] ? t : 0), 0);
  const moved = Math.min(Math.max(Math.round(value * 10), 0), 1000 - lockedTotal);
  const target = 1000 - lockedTotal - moved;
  const current = others.reduce((sum, i) => sum + tenths[i]!, 0);
  const exact = others.map((i) => (current === 0 ? target / others.length : (tenths[i]! * target) / current));

  const result = [...tenths];
  result[index] = moved;
  const floors = exact.map((x) => Math.floor(x + EPSILON));
  const leftover = target - floors.reduce((sum, f) => sum + f, 0);
  const byRemainder = others
    .map((_, j) => j)
    .sort((a, b) => {
      const diff = exact[b]! - floors[b]! - (exact[a]! - floors[a]!);
      return Math.abs(diff) > EPSILON ? diff : a - b;
    });
  others.forEach((i, j) => (result[i] = floors[j]! + (byRemainder.indexOf(j) < leftover ? 1 : 0)));
  return weights.map((w, i) => ({ key: w.key, weight: result[i]! / 10 }));
}

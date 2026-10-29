/**
 * USD per 1M tokens, OpenAI standard rates (short context) read on 2026-10-28. Reasoning tokens are billed as output and
 * are included in the output count the API reports. Keyed by the id the API reports back, so add a dated id here when
 * pinning a new model; P2-12 builds the daily view and the pre-run estimate on this.
 */
export const JUDGE_PRICES: Record<string, { input: number; output: number }> = {
  "gpt-5.4-mini-2026-03-17": { input: 0.75, output: 4.5 },
  "gpt-5.5-2026-04-23": { input: 5, output: 30 },
  "gpt-5.4-2026-03-05": { input: 2.5, output: 15 },
  "gpt-5.4-nano-2026-03-17": { input: 0.2, output: 1.25 },
  "gpt-5-mini-2025-08-07": { input: 0.25, output: 2 },
  "gpt-4.1-mini-2025-04-14": { input: 0.4, output: 1.6 },
  "gpt-5.6-luna": { input: 0.2, output: 1.2 },
};

/**
 * P1-8: what one audit's judge calls cost, in USD rounded to 6 decimals (`audit_results.cost` is NUMERIC(12,6)), over
 * every attempt including a retry. Null for a model without a price, rather than a wrong number. Pure.
 */
export function judgeCost(model: string, usage: { input_tokens: number; output_tokens: number }): number | null {
  const price = JUDGE_PRICES[model];
  if (!price) return null;
  return Math.round(usage.input_tokens * price.input + usage.output_tokens * price.output) / 1e6;
}

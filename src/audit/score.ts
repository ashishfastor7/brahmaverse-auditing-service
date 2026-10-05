import type { Rubric } from "./rubrics";
import type { MetricResult } from "./types";

/**
 * Weighted 0–100 quality score from 0–4 dimension scores. Non-applicable dimensions drop out and
 * the remaining weights are rescaled; null when none applied.
 */
export function qualityScore(rubric: Rubric, metrics: Record<string, MetricResult>): number | null {
  let total = 0;
  let weights = 0;
  for (const d of rubric.dimensions) {
    const m = metrics[d.key];
    if (!m || !m.applicable || m.score === null) continue;
    total += d.weight * (m.score / 4);
    weights += d.weight;
  }
  return weights === 0 ? null : Math.round((total / weights) * 100);
}

/** A failed call cannot score above the rubric's cap, however well the rest went. */
export function overallScore(rubric: Rubric, quality: number | null, failed: boolean): number | null {
  if (quality === null) return failed ? 0 : null;
  return failed ? Math.min(quality, rubric.fail_score_cap) : quality;
}

const TRANSCRIPT_QUALITY_FACTOR = { good: 1, fair: 0.7, poor: 0.3 } as const;

/**
 * How far to trust this audit, 0–1. Combines the judge's own confidence, whether its quotes were
 * real, and how readable the transcript was; grading without the agent's instructions costs a
 * little, since hallucination checks are then impossible.
 */
export function auditorConfidence(opts: {
  selfConfidence: number;
  evidenceValidity: number;
  transcriptQuality: keyof typeof TRANSCRIPT_QUALITY_FACTOR;
  hadAgentPrompt: boolean;
}): number {
  const self = Math.min(1, Math.max(0, opts.selfConfidence));
  let confidence = 0.4 * self + 0.35 * opts.evidenceValidity + 0.25 * TRANSCRIPT_QUALITY_FACTOR[opts.transcriptQuality];
  if (!opts.hadAgentPrompt) confidence -= 0.05;
  return Math.round(Math.min(1, Math.max(0, confidence)) * 100) / 100;
}

import type { Rubric } from "./rubrics";
import type { MetricResult } from "./types";

/**
 * 0–100 quality score: points earned over points available, counting only applicable categories
 * (so a call with nothing to troubleshoot is not marked down for it). null when none applied.
 */
export function qualityScore(metrics: Record<string, MetricResult>): number | null {
  let earned = 0;
  let available = 0;
  for (const m of Object.values(metrics)) {
    if (!m.applicable || m.score === null) continue;
    earned += m.score;
    available += m.max;
  }
  return available === 0 ? null : Math.round((earned / available) * 100);
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

import { z } from "zod";
import type { Rubric } from "../rubrics";

const SENTIMENTS = ["positive", "neutral", "negative", "frustrated", "confused"] as const;
const SEVERITIES = ["low", "medium", "high"] as const;
const TRANSCRIPT_QUALITY = ["good", "fair", "poor"] as const;
const GOAL_RESULTS = ["ACHIEVED", "NOT_ACHIEVED", "NOT_APPLICABLE"] as const;

// Strict structured output requires every property listed in `required` and no extra properties,
// at every level. Property order matters too: models generate in schema order, so reasoning and
// evidence come before the score they justify.
const obj = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const str = (description?: string) => ({ type: "string", ...(description ? { description } : {}) });
const evidenceList = {
  type: "array",
  items: obj({ turn: { type: "integer" }, quote: str("Exact words copied from that transcript turn") }),
};

/** JSON schema for the judge's response; enums come from the rubric so codes cannot drift. */
export function judgeJsonSchema(rubric: Rubric) {
  const reasonCodes = [...new Set(Object.values(rubric.goal.reason_codes).flat())];
  return obj({
    transcript_quality: obj({
      rating: { type: "string", enum: TRANSCRIPT_QUALITY },
      note: str("What, if anything, about the transcript makes judging harder"),
    }),
    failures: {
      type: "array",
      description: "Only failure conditions that clearly occurred. Empty if none.",
      items: obj({
        code: { type: "string", enum: rubric.failure_conditions.map((f) => f.code) },
        explanation: str(),
        turn: { type: "integer" },
        quote: str(),
      }),
    },
    goal: obj({
      explanation: str(),
      evidence: evidenceList,
      result: { type: "string", enum: GOAL_RESULTS },
      reason_code: { type: "string", enum: reasonCodes },
    }),
    dimensions: {
      type: "array",
      description: "Exactly one entry per rubric dimension.",
      items: obj({
        key: { type: "string", enum: rubric.dimensions.map((d) => d.key) },
        applicable: { type: "boolean", description: "false only when the call never reached what this dimension measures" },
        reasoning: str(),
        evidence: evidenceList,
        score: { type: "integer", enum: [0, 1, 2, 3, 4] },
      }),
    },
    went_well: {
      type: "array",
      items: obj({ point: str(), turn: { type: "integer" }, quote: str() }),
    },
    went_wrong: {
      type: "array",
      items: obj({ point: str(), turn: { type: "integer" }, quote: str(), severity: { type: "string", enum: SEVERITIES } }),
    },
    sentiment: obj({
      start: { type: "string", enum: SENTIMENTS },
      end: { type: "string", enum: SENTIMENTS },
      note: str("How the other party's mood moved during the call"),
    }),
    verdict: str("Two or three sentences summarising the call's quality for a reviewer"),
    confidence: { type: "number", description: "0 to 1: how sure you are of this assessment" },
  });
}

const evidence = z.array(z.object({ turn: z.number().int(), quote: z.string() }));

/** Runtime check of the judge's response — strict mode is trusted, but not blindly. */
export const judgeOutputSchema = z.object({
  transcript_quality: z.object({ rating: z.enum(TRANSCRIPT_QUALITY), note: z.string() }),
  failures: z.array(z.object({ code: z.string(), explanation: z.string(), turn: z.number().int(), quote: z.string() })),
  goal: z.object({ explanation: z.string(), evidence, result: z.enum(GOAL_RESULTS), reason_code: z.string() }),
  dimensions: z.array(
    z.object({ key: z.string(), applicable: z.boolean(), reasoning: z.string(), evidence, score: z.number().int().min(0).max(4) }),
  ),
  went_well: z.array(z.object({ point: z.string(), turn: z.number().int(), quote: z.string() })),
  went_wrong: z.array(z.object({ point: z.string(), turn: z.number().int(), quote: z.string(), severity: z.enum(SEVERITIES) })),
  sentiment: z.object({ start: z.enum(SENTIMENTS), end: z.enum(SENTIMENTS), note: z.string() }),
  verdict: z.string(),
  confidence: z.number(),
});

export type JudgeOutput = z.infer<typeof judgeOutputSchema>;

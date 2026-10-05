import { z } from "zod";
import { JUDGE_SCALE, SCORECARD, type Rubric } from "../rubrics/types";

const SENTIMENTS = ["positive", "neutral", "negative", "frustrated", "confused"] as const;
const SEVERITIES = ["low", "medium", "high"] as const;
const TRANSCRIPT_QUALITY = ["good", "fair", "poor"] as const;
const GOAL_RESULTS = ["ACHIEVED", "NOT_ACHIEVED", "NOT_APPLICABLE"] as const;
const SCORES = Array.from({ length: JUDGE_SCALE + 1 }, (_, i) => i);

// Strict structured output requires every property listed in `required` and no extra properties,
// at every level. Property order matters too: models generate in schema order, so reasoning and
// evidence come before the score they justify, and the summary before the judgement.
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
    call_summary: str("Two to four sentences: who called whom, why, what happened, and how it ended"),
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
        evidence: { ...evidenceList, description: "Every turn involved — e.g. each repetition of a loop — in turn order" },
      }),
    },
    goal: obj({
      explanation: str(),
      evidence: evidenceList,
      result: { type: "string", enum: GOAL_RESULTS },
      reason_code: { type: "string", enum: reasonCodes },
    }),
    scorecard: {
      type: "array",
      description: "Exactly one entry per scorecard category, in order.",
      items: obj({
        key: { type: "string", enum: SCORECARD.map((c) => c.key) },
        applicable: { type: "boolean", description: "false only when this category's 'not applicable' condition holds" },
        reasoning: str(),
        evidence: evidenceList,
        score: { type: "integer", enum: SCORES, description: `0 to ${JUDGE_SCALE} against the anchors; 0 if not applicable` },
      }),
    },
    went_well: {
      type: "array",
      items: obj({ point: str(), turn: { type: "integer" }, quote: str() }),
    },
    improvements: {
      type: "array",
      items: obj({
        point: str("What the agent did wrong or could have done better"),
        suggestion: str("What the agent should do instead, concretely"),
        turn: { type: "integer" },
        quote: str(),
        severity: { type: "string", enum: SEVERITIES },
      }),
    },
    sentiment: obj({
      start: { type: "string", enum: SENTIMENTS },
      end: { type: "string", enum: SENTIMENTS },
      note: str("How the other party's mood moved during the call"),
    }),
    conclusion: str("Two or three sentences: the overall judgement of how the agent handled this call"),
    confidence: { type: "number", description: "0 to 1: how sure you are of this assessment" },
  });
}

const evidence = z.array(z.object({ turn: z.number().int(), quote: z.string() }));

/** Runtime check of the judge's response — strict mode is trusted, but not blindly. */
export const judgeOutputSchema = z.object({
  call_summary: z.string(),
  transcript_quality: z.object({ rating: z.enum(TRANSCRIPT_QUALITY), note: z.string() }),
  failures: z.array(z.object({ code: z.string(), explanation: z.string(), evidence })),
  goal: z.object({ explanation: z.string(), evidence, result: z.enum(GOAL_RESULTS), reason_code: z.string() }),
  scorecard: z.array(
    z.object({ key: z.string(), applicable: z.boolean(), reasoning: z.string(), evidence, score: z.number().int().min(0).max(JUDGE_SCALE) }),
  ),
  went_well: z.array(z.object({ point: z.string(), turn: z.number().int(), quote: z.string() })),
  improvements: z.array(
    z.object({ point: z.string(), suggestion: z.string(), turn: z.number().int(), quote: z.string(), severity: z.enum(SEVERITIES) }),
  ),
  sentiment: z.object({ start: z.enum(SENTIMENTS), end: z.enum(SENTIMENTS), note: z.string() }),
  conclusion: z.string(),
  confidence: z.number(),
});

export type JudgeOutput = z.infer<typeof judgeOutputSchema>;

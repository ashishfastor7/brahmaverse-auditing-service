import OpenAI from "openai";
import type { Judge } from "../audit-call";

/**
 * The production judge: one OpenAI chat completion with a strict JSON schema. Reasoning models
 * take `reasoning_effort` and reject `temperature`; other models get temperature 0.
 *
 * `rawOnInvalidJson` (v2): a reply that isn't valid JSON is returned as its raw string instead of
 * throwing, so the caller can reject it and retry once (PRD §7).
 */
/** The judge's reply as JSON; when it isn't JSON, the raw string with `rawOnInvalidJson` (v2), else the parse error (v1). */
export function parseJudgeContent(content: string, rawOnInvalidJson: boolean): unknown {
  try {
    return JSON.parse(content);
  } catch (e) {
    if (!rawOnInvalidJson) throw e;
    return content;
  }
}

export function createOpenAIJudge(opts: {
  apiKey: string;
  model: string;
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  rawOnInvalidJson?: boolean;
}): Judge {
  const client = new OpenAI({ apiKey: opts.apiKey, timeout: 180_000, maxRetries: 2 });

  return async ({ messages, schema, schemaName }) => {
    const response = await client.chat.completions.create({
      model: opts.model,
      messages,
      response_format: { type: "json_schema", json_schema: { name: schemaName ?? "call_audit", strict: true, schema } },
      ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : { temperature: 0 }),
    });

    const choice = response.choices[0];
    if (choice?.message?.refusal) throw new Error(`judge refused: ${choice.message.refusal}`);
    const content = choice?.message?.content;
    if (!content) throw new Error(`judge returned no content (finish_reason=${choice?.finish_reason})`);

    return {
      output: parseJudgeContent(content, opts.rawOnInvalidJson ?? false),
      model: response.model,
      usage: { input_tokens: response.usage?.prompt_tokens ?? 0, output_tokens: response.usage?.completion_tokens ?? 0 },
    };
  };
}

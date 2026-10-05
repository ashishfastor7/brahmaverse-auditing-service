import OpenAI from "openai";
import type { Judge } from "../audit-call";

/**
 * The production judge: one OpenAI chat completion with a strict JSON schema. Reasoning models
 * take `reasoning_effort` and reject `temperature`; other models get temperature 0.
 */
export function createOpenAIJudge(opts: { apiKey: string; model: string; reasoningEffort?: "minimal" | "low" | "medium" | "high" }): Judge {
  const client = new OpenAI({ apiKey: opts.apiKey, timeout: 180_000, maxRetries: 2 });

  return async ({ messages, schema }) => {
    const response = await client.chat.completions.create({
      model: opts.model,
      messages,
      response_format: { type: "json_schema", json_schema: { name: "call_audit", strict: true, schema } },
      ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : { temperature: 0 }),
    });

    const choice = response.choices[0];
    if (choice?.message?.refusal) throw new Error(`judge refused: ${choice.message.refusal}`);
    const content = choice?.message?.content;
    if (!content) throw new Error(`judge returned no content (finish_reason=${choice?.finish_reason})`);

    return {
      output: JSON.parse(content),
      model: response.model,
      usage: { input_tokens: response.usage?.prompt_tokens ?? 0, output_tokens: response.usage?.completion_tokens ?? 0 },
    };
  };
}

// AWS Bedrock adapter for `TypingModelPort` (@pharmax/typing-assist).
//
// Why Bedrock and not a direct OpenAI/Anthropic API: the typing
// prompt may carry the decrypted sig (PHI). Bedrock sits inside our
// AWS BAA, does not retain prompts, and does not train on inputs —
// see docs/governance and the port header. This adapter is the ONLY
// place the worker talks to a generative model; keep it dumb.
//
// Uses the provider-agnostic Converse API so the model id is pure
// configuration (Claude, Nova, etc.) with no per-family request
// shaping here. Temperature and max-token ceiling come from the
// request (the engine pins temperature 0); this file adds nothing.
//
// Error posture: throw raw. The caller
// (`runTypingSuggestionModelStage`) maps any throw to
// FAILED("MODEL_CALL_FAILED") on the run row — classifying AWS error
// shapes here would duplicate that decision without changing it.

import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import type { TypingModelPort } from "@pharmax/typing-assist";

export interface CreateBedrockTypingModelPortOptions {
  readonly region: string;
  /** Bedrock model id or inference-profile ARN, e.g.
   *  "us.anthropic.claude-sonnet-4-20250514-v1:0". */
  readonly modelId: string;
}

export function createBedrockTypingModelPort(
  options: CreateBedrockTypingModelPortOptions
): TypingModelPort {
  const client = new BedrockRuntimeClient({ region: options.region });

  return {
    provider: "bedrock",
    complete: async (request) => {
      const response = await client.send(
        new ConverseCommand({
          modelId: options.modelId,
          system: [{ text: request.system }],
          messages: [{ role: "user", content: [{ text: request.user }] }],
          inferenceConfig: {
            maxTokens: request.maxOutputTokens,
            temperature: request.temperature,
          },
        })
      );

      const text = (response.output?.message?.content ?? [])
        .map((block) => block.text ?? "")
        .join("");

      return {
        text,
        modelId: options.modelId,
        inputTokens: response.usage?.inputTokens ?? null,
        outputTokens: response.usage?.outputTokens ?? null,
      };
    },
  };
}

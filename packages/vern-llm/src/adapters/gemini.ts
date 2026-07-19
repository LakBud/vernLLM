import type { LLMClient } from '../types.js';

/**
 * Minimal structural type for Geminis `generateContent`, matching both the
 * legacy `@google/generative-ai` SDKs `model.generateContent(...)` and the
 * newer `@google/genai` SDKs `ai.models.generateContent({ model, ... })`
 * closely enough to adapt either — pass whichever `.generateContent` you have.
 */
export interface GeminiClient {
  generateContent(
    params: {
      model?: string;
      contents: Array<{ role: 'user'; parts: Array<{ text: string }> }>;
      systemInstruction?: { parts: Array<{ text: string }> };
      generationConfig?: {
        temperature?: number;
        maxOutputTokens?: number;
        responseMimeType?: string;
        responseSchema?: Record<string, unknown>;
      };
    },
    options: { signal: AbortSignal },
  ): Promise<{
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
    };
  }>;
}

/**
 * Wraps a Gemini client so it satisfies the `LLMClient` interface VernLLM
 * uses for OpenAI/Groq. Geminis shape differs on nearly every axis: a
 * `contents` array instead of `messages`, a separate `systemInstruction`
 * field instead of a `system` role message, `generationConfig` instead of
 * top-level `temperature`/`max_tokens`, and native JSON Schema support via
 * `responseMimeType: 'application/json'` + `responseSchema` (so `jsonSchema`
 * is provider-enforced here, unlike the Anthropic adapters prompt-embedding
 * fallback). `reasoning_effort` has no equivalent. Geminis thinking models
 * use a token budget, not an effort tier, so its dropped, same as Anthropic.
 */
export function fromGemini(geminiClient: GeminiClient): LLMClient {
  return {
    chat: {
      completions: {
        async create(params, options) {
          const systemMessage = params.messages.find((m) => m.role === 'system');
          const userMessages = params.messages.filter((m) => m.role === 'user');

          const wantsJson = Boolean(params.response_format);
          const generationConfig: NonNullable<
            Parameters<GeminiClient['generateContent']>[0]['generationConfig']
          > = {
            temperature: params.temperature,
            maxOutputTokens: params.max_tokens,
          };

          if (wantsJson) {
            generationConfig.responseMimeType = 'application/json';
          }
          if (params.response_format?.type === 'json_schema') {
            generationConfig.responseSchema = params.response_format.json_schema.schema;
          }

          const response = await geminiClient.generateContent(
            {
              model: params.model,
              contents: userMessages.map((m) => ({
                role: 'user' as const,
                parts: [{ text: m.content }],
              })),
              systemInstruction: systemMessage
                ? { parts: [{ text: systemMessage.content }] }
                : undefined,
              generationConfig,
            },
            options,
          );

          const text =
            response.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';

          return {
            choices: [{ message: { content: text } }],
            usage: {
              prompt_tokens: response.usageMetadata?.promptTokenCount,
              completion_tokens: response.usageMetadata?.candidatesTokenCount,
              total_tokens: response.usageMetadata?.totalTokenCount,
            },
          };
        },
      },
    },
  };
}

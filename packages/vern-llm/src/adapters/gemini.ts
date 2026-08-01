import { assertSupportedImageMimeType } from '../internal/imageFormat.js';

import type { ContentBlock, LLMClient } from '../types/index.js';

/** Gemini's native per-part content shape for a `contents` entry. */
type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };

/**
 * Minimal structural type for Geminis `generateContent`, matching the
 * `@google/genai` SDKs `ai.models.generateContent({ model, ... })` shape.
 */
export interface GeminiClient {
  generateContent(
    params: {
      model?: string;
      contents: Array<{ role: 'user' | 'model'; parts: GeminiPart[] }>;
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
 * Translates a VernLLM `ContentBlock[]` into Gemini's native `parts` array:
 * text blocks become `{ text }`, image blocks become inline data parts
 * (`{ inlineData: { mimeType, data } }`), Geminis shape for embedding raw
 * base64 image bytes directly in the request.
 */
function toGeminiParts(blocks: ContentBlock[]): GeminiPart[] {
  return blocks.map((block) =>
    block.type === 'image'
      ? { inlineData: { mimeType: assertSupportedImageMimeType(block.mimeType), data: block.data } }
      : { text: block.text },
  );
}

/**
 * Wraps a Gemini client so it satisfies the `LLMClient` interface VernLLM
 * uses for OpenAI-compatible APIs. Geminis shape differs on nearly every axis:
 * a `contents` array instead of `messages`, a separate `systemInstruction`
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
          // Keep both user and assistant turns, in order. Gemini calls the
          // assistant role 'model' rather than 'assistant'.
          const conversationMessages = params.messages.filter(
            (m) => m.role === 'user' || m.role === 'assistant',
          );

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
              contents: conversationMessages.map((m) => ({
                role: m.role === 'assistant' ? ('model' as const) : ('user' as const),
                parts: Array.isArray(m.content) ? toGeminiParts(m.content) : [{ text: m.content }],
              })),
              systemInstruction: systemMessage
                ? // System turns are always plain strings; only user turns can carry ContentBlock[]
                  { parts: [{ text: systemMessage.content as string }] }
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

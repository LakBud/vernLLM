/** Gemini's per-part content shape; object-typed args match the real SDK. */
export type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { id?: string; name: string; args: Record<string, unknown> } }
  | { functionResponse: { id?: string; name: string; response: Record<string, unknown> } };

/**
 * Structural type matching the model methods of the real `@google/genai`
 * SDK (`ai.models`).
 *
 * Every field is shaped to be structurally assignable from the real SDK's
 * generated types without importing them, so provider SDKs stay optional:
 * `model` is required (the real SDK requires it), `functionCall.args` /
 * `functionResponse.response` are `Record<string, unknown>` (matching the
 * real SDK, not `unknown`), `toolConfig...mode` is `any` (TypeScript never
 * treats a string-literal union as assignable to the real SDK's string
 * enum), and response-side `functionCall.name` is optional (matching the
 * real SDK).
 */
export interface GeminiModels {
  generateContent(params: {
    model: string;
    contents: Array<{ role: 'user' | 'model'; parts: GeminiPart[] }>;
    config?: {
      systemInstruction?: { parts: Array<{ text: string }> };
      temperature?: number;
      maxOutputTokens?: number;
      responseMimeType?: string;
      responseSchema?: Record<string, unknown>;
      tools?: Array<{
        functionDeclarations: Array<{
          name: string;
          description?: string;
          parameters: Record<string, unknown>;
        }>;
      }>;
      toolConfig?: {
        functionCallingConfig: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see class doc comment above
          mode: any;
          allowedFunctionNames?: string[];
        };
      };
      /** `thinkingBudget` up to Gemini 2.5, `thinkingLevel` from Gemini 3 on. */
      thinkingConfig?: {
        thinkingBudget?: number;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see class doc comment above
        thinkingLevel?: any;
      };
      abortSignal?: AbortSignal;
    };
  }): Promise<{
    candidates?: Array<{
      content?: {
        parts?: Array<{
          text?: string;
          functionCall?: { id?: string; name?: string; args?: unknown };
        }>;
      };
      finishReason?: string;
    }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
      thoughtsTokenCount?: number;
      cachedContentTokenCount?: number;
    };
  }>;

  /** Required only for `stream: true`. Resolves to an iterable of partial responses. */
  generateContentStream?(params: Parameters<GeminiModels['generateContent']>[0]): Promise<
    AsyncIterable<{
      candidates?: Array<{
        content?: {
          parts?: Array<{
            text?: string;
            functionCall?: { id?: string; name?: string; args?: unknown };
          }>;
        };
      }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
        thoughtsTokenCount?: number;
        cachedContentTokenCount?: number;
      };
    }>
  >;
}

/**
 * The top level `@google/genai` client, `new GoogleGenAI(...)`:
 *
 * ```ts
 * import { GoogleGenAI } from '@google/genai';
 * const ai = new GoogleGenAI({ apiKey: '...' });
 * const llm = new VernLLM({ client: fromGemini(ai), model: 'gemini-2.5-flash' });
 * ```
 */
export interface GeminiClient {
  models: GeminiModels;
  /** Set by the SDK; names the provider as Vertex AI or the Gemini API. */
  vertexai?: boolean;
}

export type GeminiRequest = Parameters<GeminiModels['generateContent']>[0];

export type GeminiConfig = NonNullable<GeminiRequest['config']>;

export type GeminiResponse = Awaited<ReturnType<GeminiModels['generateContent']>>;
export type GeminiStream = Awaited<ReturnType<NonNullable<GeminiModels['generateContentStream']>>>;

export type GeminiUsage = NonNullable<
  Awaited<ReturnType<GeminiModels['generateContent']>>['usageMetadata']
>;

import {
  LLMError,
  type ContentBlock,
  type LLMClient,
  type WireStreamChunk,
  type WireToolCall,
} from '../types/index.js';
import { assertSupportedImageMimeType } from './internal/imageFormat.js';

/**
 * Gemini's native per-part content shape for a `contents` entry.
 * `functionCall.args` and `functionResponse.response` are typed as
 * `Record<string, unknown>` (not `unknown`) to match the real SDK's
 * `FunctionCall.args` / `FunctionResponse.response`, see the doc comment
 * on {@link GeminiClient}.
 */
type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

/**
 * Structural type matching the real `@google/genai` SDK, in either of the
 * two shapes it's commonly held in: the callable model methods directly
 * (what the real SDK exposes as `ai.models`), or the complete top-level
 * client (`ai` itself, via the optional `models` field below). Both work
 * with `fromGemini` directly, with no cast:
 *
 * ```ts
 * import { GoogleGenAI } from '@google/genai';
 * const ai = new GoogleGenAI({ apiKey: '...' });
 * const llm = new VernLLM({ client: fromGemini(ai.models), model: 'gemini-2.5-flash' });
 * // or, equivalently:
 * const llm2 = new VernLLM({ client: fromGemini(ai), model: 'gemini-2.5-flash' });
 * ```
 *
 * `generateContent` is optional here (unlike the real SDK, where it's
 * always present) specifically so that a `{ models: ... }`-shaped value
 * (no top-level `generateContent` of its own) is still a structural
 * `GeminiClient`. `fromGemini` resolves `models` at runtime and throws if
 * the result has no `generateContent`, see its own doc comment.
 *
 * Every field here is deliberately shaped to be *structurally* assignable
 * from the real SDK's generated types (`GenerateContentParameters`,
 * `GenerateContentResponse`, `GoogleGenAI`, etc.), without importing them,
 * so provider SDKs stay optional:
 * - `model` is required (not optional) on `generateContent`'s params,
 *   matching the real SDK's `GenerateContentParameters.model`. VernLLM's
 *   own request builder always sets it, so this costs nothing internally,
 *   and it's required for real-SDK assignability: the real SDK's `model`
 *   is non-optional, so a params type that allows omitting it isn't a
 *   structural subtype of the real SDK's parameter type.
 * - `functionCall.args` (request side, inside `GeminiPart`) and
 *   `functionResponse.response` are typed as `Record<string, unknown>`,
 *   matching the real SDK's `FunctionCall.args` and
 *   `FunctionResponse.response`, both `Record<string, unknown> | undefined`
 *   there rather than `unknown`.
 * - `toolConfig.functionCallingConfig.mode` is typed as `any`. The real
 *   SDK types this as its own `FunctionCallingConfigMode` string enum;
 *   TypeScript never treats a plain string-literal union as assignable to
 *   a string enum (even when the literal values match exactly), so no
 *   independently-declared union type can satisfy it structurally. `any`
 *   is the narrowest escape hatch available without importing the real
 *   enum; it doesn't weaken anything at runtime since VernLLM only ever
 *   writes one of `'AUTO' | 'ANY' | 'NONE'` here itself.
 * - The response side's `functionCall.name` is optional (`name?: string`),
 *   matching the real SDK's `FunctionCall.name?: string`, since the
 *   response type only needs to be a supertype of whatever the real SDK
 *   actually returns.
 */
export interface GeminiClient {
  /**
   * Present when this `GeminiClient` is actually the whole top-level SDK
   * client (`ai`, not `ai.models`). `fromGemini` unwraps this at runtime;
   * see its doc comment. Self-referencing rather than a separate type so
   * one `GeminiClient` covers both shapes the real SDK is commonly held
   * in, with nothing else to import or name.
   */
  models?: GeminiClient;

  generateContent?(params: {
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
      abortSignal?: AbortSignal;
    };
  }): Promise<{
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string; functionCall?: { name?: string; args?: unknown } }>;
      };
    }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
    };
  }>;

  /**
   * Optional. Required only for `stream: true` calls. Takes the same
   * request shape as `generateContent`. Matching the real SDK's own
   * `generateContentStream`, this resolves to an `AsyncIterable` (rather
   * than returning one synchronously) of partial responses, each chunk
   * holding the same `candidates[].content.parts[]` structure as
   * `generateContent`'s response, just incremental.
   */
  generateContentStream?(
    params: Parameters<NonNullable<GeminiClient['generateContent']>>[0],
  ): Promise<
    AsyncIterable<{
      candidates?: Array<{
        content?: {
          parts?: Array<{ text?: string; functionCall?: { name?: string; args?: unknown } }>;
        };
      }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
      };
    }>
  >;
}

/**
 * Translates a VernLLM `ContentBlock[]` into Gemini's native `parts` array:
 * text blocks become `{ text }`, image blocks become inline data parts
 * (`{ inlineData: { mimeType, data } }`), Gemini's shape for embedding raw
 * base64 image bytes directly in the request.
 */
function toGeminiParts(blocks: ContentBlock[]): GeminiPart[] {
  return blocks.map((block) =>
    block.type === 'image'
      ? { inlineData: { mimeType: assertSupportedImageMimeType(block.mimeType), data: block.data } }
      : { text: block.text },
  );
}

/** Maps VernLLM's OpenAI-shaped wire `tool_choice` onto Gemini's `functionCallingConfig`. */
function toGeminiToolConfig(
  toolChoice: Parameters<LLMClient['chat']['completions']['create']>[0]['tool_choice'],
): NonNullable<
  NonNullable<Parameters<NonNullable<GeminiClient['generateContent']>>[0]['config']>['toolConfig']
> {
  if (!toolChoice || toolChoice === 'auto') {
    return { functionCallingConfig: { mode: 'AUTO' } };
  }
  if (toolChoice === 'none') {
    return { functionCallingConfig: { mode: 'NONE' } };
  }
  if (toolChoice === 'required') {
    return { functionCallingConfig: { mode: 'ANY' } };
  }

  return {
    functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [toolChoice.function.name] },
  };
}

/**
 * Translates one VernLLM wire message into a Gemini `contents` entry.
 * Gemini has no separate 'tool' role: a prior assistant tool request
 * becomes a `'model'` turn with `functionCall` parts, and its result
 * becomes a `'user'` turn with `functionResponse` parts.
 */
function toGeminiContent(
  m: Extract<
    Parameters<LLMClient['chat']['completions']['create']>[0]['messages'][number],
    { role: 'user' | 'assistant' | 'tool' }
  >,
): { role: 'user' | 'model'; parts: GeminiPart[] } {
  if (m.role === 'tool') {
    // Gemini's functionResponse identifies the call by function *name*, and
    // the Gemini branch of this adapter sets wire tool_call ids equal to
    // the function name for exactly this reason, so tool_call_id here is
    // already the name Gemini expects.
    return {
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: m.tool_call_id,
            response: parseToolResult(m.content),
          },
        },
      ],
    };
  }

  if (m.role === 'assistant' && m.tool_calls?.length) {
    const parts: GeminiPart[] = [];

    if (typeof m.content === 'string' && m.content) {
      parts.push({ text: m.content });
    }

    parts.push(
      ...m.tool_calls.map((tc) => ({
        functionCall: {
          name: tc.function.name,
          args: parseToolArguments(tc.function.arguments, tc.function.name),
        },
      })),
    );

    return {
      role: 'model',
      parts,
    };
  }

  return {
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: Array.isArray(m.content) ? toGeminiParts(m.content) : [{ text: m.content ?? '' }],
  };
}

function parseToolArguments(text: string, toolName: string): Record<string, unknown> {
  let parsed: unknown;

  try {
    parsed = text.trim() ? JSON.parse(text) : {};
  } catch (cause) {
    throw new LLMError(`Tool call "${toolName}" arguments are not valid JSON.`, 'parse', {
      cause,
      code: 'tool_arguments_parse_failed',
    });
  }

  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new LLMError(`Tool call "${toolName}" arguments must be a JSON object.`, 'validation');
  }

  return parsed as Record<string, unknown>;
}

/**
 * Parses a wire tool message's `content` into the object Gemini's
 * `functionResponse.response` expects. Gemini (and the real SDK's
 * `FunctionResponse.response` type) requires an object, so a result that
 * parses to something other than a plain JSON object (a string, number,
 * array, or unparseable text) is wrapped under an `output` key, mirroring
 * Gemini's own documented convention for non-object function results.
 */
function parseToolResult(text: string): Record<string, unknown> {
  let parsed: unknown;

  try {
    parsed = text.trim() ? JSON.parse(text) : '';
  } catch {
    parsed = text;
  }

  if (parsed && !Array.isArray(parsed) && typeof parsed === 'object') {
    return parsed as Record<string, unknown>;
  }

  return { output: parsed };
}

/**
 * Gemini expects the results of everything the model asked for in one turn
 * to arrive together as multiple `functionResponse` parts on a single
 * `'user'` entry, not as separate consecutive `'user'` entries. The
 * per-wire-message mapping above produces one `'user'` entry per VernLLM
 * wire tool message, so when an assistant turn requested more than one
 * tool, this merges the resulting run of functionResponse-only `'user'`
 * entries back into one.
 */
function mergeConsecutiveFunctionResponses(
  contents: { role: 'user' | 'model'; parts: GeminiPart[] }[],
): { role: 'user' | 'model'; parts: GeminiPart[] }[] {
  const isFunctionResponseOnly = (
    c: (typeof contents)[number],
  ): c is { role: 'user'; parts: GeminiPart[] } =>
    c.role === 'user' && c.parts.length > 0 && c.parts.every((p) => 'functionResponse' in p);

  const merged: (typeof contents)[number][] = [];

  for (const c of contents) {
    const prev = merged.at(-1);

    if (isFunctionResponseOnly(c) && prev && isFunctionResponseOnly(prev)) {
      prev.parts.push(...c.parts);
    } else {
      merged.push(c);
    }
  }

  return merged;
}

type GeminiRequest = Parameters<NonNullable<GeminiClient['generateContent']>>[0];
type GeminiConfig = NonNullable<GeminiRequest['config']>;

/**
 * Builds the Gemini-shaped request from VernLLM's wire params, shared
 * between `create` and `createStream` so both go through identical
 * translation (contents shaping, `responseSchema`/`responseMimeType`
 * mapping, and tool/toolConfig translation all happen exactly once).
 * `abortSignal` is folded into `config` by the caller (`create`/
 * `createStream`), once the request options are available.
 */
function buildGeminiRequest(
  params: Parameters<LLMClient['chat']['completions']['create']>[0],
): GeminiRequest {
  const systemMessage = params.messages.find((m) => m.role === 'system');
  // Keep user, assistant, and tool turns, in order.
  const conversationMessages = params.messages.filter(
    (m) => m.role === 'user' || m.role === 'assistant' || m.role === 'tool',
  );

  const wantsJson = Boolean(params.response_format);
  const config: GeminiConfig = {
    ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
    maxOutputTokens: params.max_tokens,
    ...(systemMessage
      ? // System turns are always plain strings; only user turns can carry ContentBlock[]
        { systemInstruction: { parts: [{ text: systemMessage.content as string }] } }
      : {}),
  };

  if (wantsJson) {
    config.responseMimeType = 'application/json';
  }

  if (params.response_format?.type === 'json_schema') {
    const { schema, description } = params.response_format.json_schema;

    config.responseSchema = {
      ...schema,
      ...(description ? { description } : {}),
    };
  }

  if (params.tools?.length) {
    config.tools = [
      {
        functionDeclarations: params.tools.map((t) => ({
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        })),
      },
    ];
    config.toolConfig = toGeminiToolConfig(params.tool_choice);
  }

  return {
    model: params.model,
    contents: mergeConsecutiveFunctionResponses(
      conversationMessages.map((m) => toGeminiContent(m)),
    ),
    config,
  };
}

/**
 * Wraps a Gemini client so it satisfies the `LLMClient` interface VernLLM
 * uses for OpenAI-compatible APIs. Gemini's shape differs on nearly every
 * axis: a `contents` array instead of `messages`, a separate
 * `systemInstruction` field instead of a `system` role message,
 * `generationConfig` instead of top-level `temperature`/`max_tokens`, and
 * native JSON Schema support via `responseMimeType: 'application/json'` +
 * `responseSchema`. `reasoning_effort` has no equivalent. Gemini's thinking
 * models use a token budget, not an effort tier, so it's dropped, same as
 * Anthropic.
 *
 * `tools` maps to Gemini's native `functionDeclarations`/`functionCall`;
 * `tool_choice` maps to `toolConfig.functionCallingConfig`. Gemini accepts
 * `responseSchema` and `tools` in the same request natively, so both are
 * set independently here and no special-casing is needed for the
 * combination, unlike `fromAnthropic`/`fromBedrock`.
 *
 * `createStream` calls `generateContentStream` (optional on `GeminiClient`
 *, required only if the caller sets `stream: true`) and translates each
 * partial response into `WireStreamChunk`s. Unlike OpenAI/Anthropic,
 * Gemini's own function-calling API doesn't stream tool-call arguments
 * incrementally: a `functionCall` part always arrives whole in one chunk,
 * so each one is emitted as a single, complete `tool_call_delta` (a
 * one-shot "delta" containing the full arguments) rather than accumulated
 * fragments, that's a real difference in the underlying API, not
 * something this adapter can smooth over. `usageMetadata` is (per Gemini's
 * own behavior) only reliably present on the last chunk, so the `usage`
 * `WireStreamChunk` is emitted once, after the stream completes, from
 * whichever chunk's `usageMetadata` was seen last.
 *
 * Accepts a `GeminiClient` in either of the two shapes it structurally
 * covers: the callable model methods directly (what the real SDK exposes
 * as `ai.models`), or the complete top-level client (`ai` itself, via its
 * `models` field), unwrapping `.models` internally when given the latter.
 * This means both of the following work, with no cast in either case:
 *
 * ```ts
 * fromGemini(ai.models); // existing callers keep working
 * fromGemini(ai);        // .models is Gemini-specific, and stays hidden in here
 * ```
 *
 * Resolution is a plain runtime check: if `client.models` is set, that's
 * used; otherwise `client` itself is used directly. Throws an
 * `LLMError('invalid_params')` up front if neither the client nor its
 * `.models` actually has a `generateContent` (which `GeminiClient` allows
 * structurally, since that's what makes the `{ models: ... }` shape valid
 * in the first place).
 */
export function fromGemini(client: GeminiClient): LLMClient {
  const resolved = client.models ?? client;

  if (!resolved.generateContent) {
    throw new LLMError(
      'fromGemini requires a client with generateContent: pass ai.models, or the whole ai client (fromGemini(ai)).',
      'invalid_params',
      { code: 'unsupported_capability', issues: { capability: 'generateContent' } },
    );
  }

  const generateContent = resolved.generateContent;
  const generateContentStream = resolved.generateContentStream;

  return {
    chat: {
      completions: {
        async create(params, options) {
          const request = buildGeminiRequest(params);
          request.config = { ...request.config, abortSignal: options.signal };

          const response = await generateContent(request);

          const parts = response.candidates?.[0]?.content?.parts ?? [];
          const text = parts.map((p) => p.text ?? '').join('');
          const functionCalls = parts.filter((p) => p.functionCall);

          let wireToolCalls: WireToolCall[] | undefined;

          if (functionCalls.length) {
            wireToolCalls = functionCalls.map((p) => ({
              // Gemini's functionResponse correlates by function *name*, not
              // a call id (Gemini has no call-id concept at all), so the id
              // here is just the name. This means two calls to the *same*
              // tool within one turn can't be told apart when results come
              // back, a real limitation of Gemini's own function-calling
              // API, not something VernLLM can paper over.
              // INVARIANT: `name` is typed optional (matching the real
              // SDK's own `FunctionCall.name?: string`), but Gemini always
              // populates it on an actual function call part in practice;
              // the `!` here asserts that invariant, same rationale as the
              // `complete: true` invariant on the streaming path below.
              id: p.functionCall!.name!,
              type: 'function' as const,
              function: {
                name: p.functionCall!.name!,
                arguments: JSON.stringify(p.functionCall!.args ?? {}),
              },
            }));
          }

          return {
            choices: [
              {
                message: { content: text, ...(wireToolCalls ? { tool_calls: wireToolCalls } : {}) },
              },
            ],
            usage: {
              prompt_tokens: response.usageMetadata?.promptTokenCount,
              completion_tokens: response.usageMetadata?.candidatesTokenCount,
              total_tokens: response.usageMetadata?.totalTokenCount,
            },
          };
        },

        async *createStream(params, options) {
          if (!generateContentStream) {
            throw new LLMError(
              'stream: true requires a Gemini client with generateContentStream',
              'invalid_params',
              { code: 'unsupported_capability', issues: { capability: 'generateContentStream' } },
            );
          }

          const request = buildGeminiRequest(params);
          request.config = { ...request.config, abortSignal: options.signal };

          const stream = await generateContentStream(request);

          let toolCallIndex = 0;
          let lastUsage:
            | NonNullable<
                Awaited<ReturnType<NonNullable<GeminiClient['generateContent']>>>['usageMetadata']
              >
            | undefined;

          for await (const chunk of stream) {
            const parts = chunk.candidates?.[0]?.content?.parts ?? [];

            for (const part of parts) {
              if (part.text) {
                yield { type: 'text-delta', delta: part.text };
              }

              if (part.functionCall) {
                yield {
                  type: 'tool_call_delta',
                  index: toolCallIndex,
                  id: part.functionCall.name,
                  name: part.functionCall.name,
                  argumentsDelta: JSON.stringify(part.functionCall.args ?? {}),
                  // INVARIANT: assumes Gemini always sends a complete
                  // function-call args blob per part, no incremental
                  // streaming, per current API behavior. There is no field
                  // on this minimal structural type to derive this from.
                  // If Gemini ever starts streaming args incrementally,
                  // this becomes silently wrong. See the test titled
                  // "INVARIANT: hardcodes complete: true on
                  // tool_call_delta" in gemini.stream.unit.test.ts, which
                  // exists specifically to catch that drift.
                  complete: true,
                } satisfies WireStreamChunk;
                toolCallIndex++;
              }
            }

            if (chunk.usageMetadata) {
              lastUsage = chunk.usageMetadata;
            }
          }

          if (lastUsage) {
            yield {
              type: 'usage',
              usage: {
                prompt_tokens: lastUsage.promptTokenCount,
                completion_tokens: lastUsage.candidatesTokenCount,
                total_tokens: lastUsage.totalTokenCount,
              },
            };
          }
        },
      },
    },
  };
}

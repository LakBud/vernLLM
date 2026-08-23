import {
  LLMError,
  type ContentBlock,
  type LLMClient,
  type WireStreamChunk,
  type WireToolCall,
} from '../types/index.js';
import { assertSupportedImageMimeType } from './internal/imageFormat.js';
import {
  budgetTokensToEffort,
  effortToBudgetTokens,
  resolveEffortTokenTable,
  toGeminiThinkingLevel,
  usesGeminiThinkingLevel,
  type EffortTokenTable,
} from './internal/reasoningBudget.utils.js';

import type { ModelCapabilityOverride } from './internal/nativeStructuredOutput.js';

/**
 * Gemini has no per-call tool-call id: a `functionCall` part carries only
 * a name, and `functionResponse` correlates by that same name. That's
 * fine for one call per tool per turn, but two parallel calls to the
 * *same* tool (e.g. "check the weather in NYC and LA") would otherwise
 * synthesize the same wire `id` twice, which `callExecutor`'s
 * `validateToolCallArguments` rightly rejects as `duplicate_tool_call_id`.
 * Its a real ambiguity for every other provider, but a false positive here
 * since Gemini's own ordering already disambiguates them. This assigns
 * the bare name to the first call to a given tool in a turn and suffixes
 * `#n` on every later one, so ids stay unique; `toGeminiContent` strips
 * the suffix back off before sending a tool result to `functionResponse`,
 * which only ever expects the bare name.
 */
function dedupeToolCallId(name: string, seen: Map<string, number>): string {
  const n = seen.get(name) ?? 0;
  seen.set(name, n + 1);
  return n === 0 ? name : `${name}#${n}`;
}

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
 * Structural type matching the real `@google/genai` SDK, in either shape
 * it's commonly held in: the callable model methods directly (`ai.models`),
 * or the complete top-level client (`ai`, via the optional `models` field
 * below). Both work with `fromGemini` directly, with no cast:
 *
 * ```ts
 * import { GoogleGenAI } from '@google/genai';
 * const ai = new GoogleGenAI({ apiKey: '...' });
 * const llm = new VernLLM({ client: fromGemini(ai), model: 'gemini-2.5-flash' });
 * ```
 *
 * `generateContent` is optional so a `{ models: ... }`-shaped value is
 * still a structural `GeminiClient`; `fromGemini` resolves `models` at
 * runtime and throws if nothing callable results.
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
export interface GeminiClient {
  /** Present when this is the whole top-level SDK client, not `ai.models`. `fromGemini` unwraps it at runtime. */
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
      /**
       * Native reasoning control. `thinkingBudget` is built from
       * `CallParams.budgetTokens` directly when set (0 disables thinking,
       * -1 requests automatic budgeting, both passed through unchanged),
       * or converted from `reasoningEffort`, on Gemini 2.5 and earlier
       * models. `thinkingLevel` is used instead on Gemini 3 and later,
       * which use a level-based control rather than a numeric budget.
       * `any`, same reason as `toolConfig...mode` above, see class doc
       * comment. See `usesGeminiThinkingLevel` in
       * `adapters/internal/reasoningBudget.utils.ts`.
       */
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
        parts?: Array<{ text?: string; functionCall?: { name?: string; args?: unknown } }>;
      };
    }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
      thoughtsTokenCount?: number;
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
        thoughtsTokenCount?: number;
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
    // Gemini's functionResponse identifies the call by function *name*.
    // tool_call_id is normally already that name, but may carry a
    // VernLLM-added "#n" disambiguator for the 2nd+ parallel call to the
    // same tool in one turn (see `dedupeToolCallId`) — strip it back off
    // before sending, since Gemini only ever expects the bare name.
    const name = m.tool_call_id.replace(/#\d+$/, '');
    return {
      role: 'user',
      parts: [
        {
          functionResponse: {
            name,
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
  effortTokenTable?: EffortTokenTable,
  thinkingLevelModels?: ModelCapabilityOverride,
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

  // On Gemini 3 and later, `thinkingConfig.thinkingLevel` is the native
  // reasoning control, not `thinkingBudget`. `reasoning_effort` maps onto
  // it directly (VernLLM's own four tiers line up exactly with Gemini's
  // level enum). When only `budget_tokens` was set, it's converted to
  // the nearest tier first, same table used elsewhere. Sending
  // `thinkingBudget` there instead still works for backward
  // compatibility, per Google's own docs, but "may result in unexpected
  // performance", so VernLLM switches over rather than keeping every
  // Gemini generation on the older field indefinitely. Note that 0
  // (disabled) and -1 (automatic) have no `thinkingLevel` equivalent:
  // both collapse to `minimal` through the same conversion table,
  // `MINIMAL` being the closest available approximation of "off", which
  // several Gemini 3 models can't be fully disabled on anyway.
  if (usesGeminiThinkingLevel(params.model, thinkingLevelModels)) {
    const effortTier =
      params.reasoning_effort ??
      (params.budget_tokens !== undefined
        ? budgetTokensToEffort(params.budget_tokens, effortTokenTable)
        : undefined);

    if (effortTier !== undefined) {
      config.thinkingConfig = { thinkingLevel: toGeminiThinkingLevel(effortTier, params.model) };
    }
  } else {
    // `thinkingBudget` is Gemini's native reasoning control on 2.5 and
    // earlier, 0 disables thinking and -1 requests automatic budgeting,
    // both passed through unchanged rather than run through the effort
    // table below. Used directly when the caller set `budget_tokens`.
    // When only `reasoning_effort` was set, it's converted to the
    // nearest token budget, since these models have no tier string of
    // their own.
    const thinkingBudget =
      params.budget_tokens ??
      (params.reasoning_effort
        ? effortToBudgetTokens(params.reasoning_effort, effortTokenTable)
        : undefined);

    if (thinkingBudget !== undefined) {
      config.thinkingConfig = { thinkingBudget };
    }
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
 * `responseSchema`. `reasoning_effort` has no native Gemini equivalent, so
 * it's converted to a `thinkingConfig.thinkingBudget` token count; `budget_tokens`
 * maps to `thinkingBudget` directly, Gemini's native reasoning control. See
 * `adapters/internal/reasoningBudget.utils.ts`.
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
 * Accepts a `GeminiClient` in either shape it structurally covers: the
 * callable model methods directly (`ai.models`), or the complete
 * top-level client (`ai`), unwrapping `.models` internally when present.
 * Both work with no cast: `fromGemini(ai.models)` and `fromGemini(ai)`.
 * Throws `LLMError('invalid_params')` up front if nothing callable
 * results.
 */
export interface GeminiAdapterOptions {
  /**
   * Overrides the token count `reasoningEffort` tiers map onto when the
   * caller sets `reasoningEffort` but not `budgetTokens` (Gemini has no
   * tier string of its own, see `adapters/internal/reasoningBudget.utils.ts`).
   * Only the tiers listed are changed; any omitted tier keeps the
   * built-in default. Has no effect when `budgetTokens` is set directly.
   */
  reasoningEffortTokens?: Partial<EffortTokenTable>;
  /**
   * Marks additional models as using `thinkingLevel` instead of
   * `thinkingBudget`, on top of this package's own built-in rule (every
   * Gemini 3 series model and later, see `usesGeminiThinkingLevel` in
   * `adapters/internal/reasoningBudget.utils.ts`). Additive, not a
   * replacement: it can correct a false negative (a newer model this
   * package doesn't know about yet), it can't un-mark a model the
   * built-in rule already caught. Pass a static list of model IDs or a
   * predicate.
   */
  thinkingLevelModels?: ModelCapabilityOverride;
}

export function fromGemini(client: GeminiClient, options?: GeminiAdapterOptions): LLMClient {
  const effortTokenTable = resolveEffortTokenTable(options?.reasoningEffortTokens);
  const thinkingLevelModels = options?.thinkingLevelModels;
  const resolved = client.models ?? client;

  if (typeof resolved.generateContent !== 'function') {
    throw new LLMError(
      'fromGemini requires a client with generateContent: pass ai.models, or the whole ai client (fromGemini(ai)).',
      'invalid_params',
      { code: 'unsupported_capability', issues: { capability: 'generateContent' } },
    );
  }

  const generateContent = resolved.generateContent.bind(resolved);
  const generateContentStream =
    typeof resolved.generateContentStream === 'function'
      ? resolved.generateContentStream.bind(resolved)
      : undefined;

  return {
    chat: {
      completions: {
        async create(params, options) {
          const request = buildGeminiRequest(params, effortTokenTable, thinkingLevelModels);
          request.config = { ...request.config, abortSignal: options.signal };

          const response = await generateContent(request);

          const parts = response.candidates?.[0]?.content?.parts ?? [];
          const text = parts.map((p) => p.text ?? '').join('');
          const functionCalls = parts.filter((p) => p.functionCall);

          let wireToolCalls: WireToolCall[] | undefined;

          if (functionCalls.length) {
            const seen = new Map<string, number>();
            wireToolCalls = functionCalls.map((p) => ({
              // Gemini's functionResponse correlates by function *name*, not
              // a call id (Gemini has no call-id concept at all), so the id
              // here is derived from the name, disambiguated across
              // multiple calls to the same tool within one turn by
              // `dedupeToolCallId` (see its doc comment).
              // INVARIANT: `name` is typed optional (matching the real
              // SDK's own `FunctionCall.name?: string`), but Gemini always
              // populates it on an actual function call part in practice;
              // the `!` here asserts that invariant, same rationale as the
              // `complete: true` invariant on the streaming path below.
              id: dedupeToolCallId(p.functionCall!.name!, seen),
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
              ...(response.usageMetadata?.thoughtsTokenCount !== undefined
                ? {
                    completion_tokens_details: {
                      reasoning_tokens: response.usageMetadata.thoughtsTokenCount,
                    },
                  }
                : {}),
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

          const request = buildGeminiRequest(params, effortTokenTable, thinkingLevelModels);
          request.config = { ...request.config, abortSignal: options.signal };

          const stream = await generateContentStream(request);

          let toolCallIndex = 0;
          const seen = new Map<string, number>();
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
                  // Disambiguated the same way as the non-streaming path
                  // (see `dedupeToolCallId`'s doc comment); Gemini always
                  // sends a function call whole in one chunk (per the
                  // `complete: true` invariant below), so counting per
                  // chunk here is equivalent to counting per response.
                  id: part.functionCall.name
                    ? dedupeToolCallId(part.functionCall.name, seen)
                    : undefined,
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
                ...(lastUsage.thoughtsTokenCount !== undefined
                  ? {
                      completion_tokens_details: { reasoning_tokens: lastUsage.thoughtsTokenCount },
                    }
                  : {}),
              },
            };
          }
        },
      },
    },
  };
}

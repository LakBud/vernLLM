import {
  LLMError,
  type ContentBlock,
  type LLMClient,
  type WireStreamChunk,
  type WireToolCall,
} from '../types/index.js';
import {
  assertSupportedImageMimeType,
  type SupportedImageMimeType,
} from './internal/imageFormat.js';
import {
  supportsNativeStructuredOutput,
  type ModelCapabilityOverride,
} from './internal/nativeStructuredOutput.js';

/** Anthropic's native per-block content shape for a message. */
type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: { type: 'base64'; media_type: SupportedImageMimeType; data: string };
    }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

/** Minimal structural type for the Anthropic SDK's `messages.create` */
export interface AnthropicClient {
  messages: {
    create(
      params: {
        model: string;
        max_tokens: number;
        temperature?: number;
        system?: string;
        messages: Array<{ role: 'user' | 'assistant'; content: string | AnthropicContentBlock[] }>;
        tools?: Array<{
          name: string;
          description?: string;
          // The real Anthropic SDK's `Tool.input_schema` requires the
          // literal `type: 'object'` (VernLLM's own public `tools` API
          // accepts freeform JSON Schema, so this is narrower than that);
          // see the two call sites below for how a caller's schema is
          // asserted into this shape.
          input_schema: { type: 'object'; [key: string]: unknown };
          strict?: boolean;
        }>;
        tool_choice?:
          | { type: 'auto' }
          | { type: 'any' }
          | { type: 'none' }
          | { type: 'tool'; name: string };
        /**
         * Native, schema-constrained output: a separate request field from
         * `tools`/`tool_choice`, so it can be sent alongside real tool
         * calls. Only built by this adapter for models covered by
         * `nativeStructuredOutputModels` (opt-in, see
         * `AnthropicAdapterOptions`); other models keep getting
         * `jsonSchema` emulated as a forced single tool call, the
         * pre-existing behavior.
         *
         * Matches the real Anthropic API's `output_config.format` shape
         * exactly: just `type` and `schema`, no `name`/`description`/
         * `strict`. Those three exist on VernLLM's own `jsonSchema` API
         * (and are still forwarded on the legacy forced-tool-call path,
         * where they're real `Tool` fields), but the native structured-
         * output endpoint has no equivalent for any of them.
         */
        output_config?: {
          format: {
            type: 'json_schema';
            schema: Record<string, unknown>;
          };
        };
      },
      options: { signal: AbortSignal },
    ): Promise<{
      content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    }>;
  };
}

/**
 * Translates a VernLLM `ContentBlock[]` (our provider-agnostic multimodal
 * shape) into Anthropic's native content-block array: text blocks pass
 * through as-is, image blocks become `{ type: 'image', source: { type:
 * 'base64', media_type, data } }`.
 */
function toAnthropicContent(blocks: ContentBlock[]): AnthropicContentBlock[] {
  return blocks.map((block) =>
    block.type === 'image'
      ? {
          type: 'image',
          source: {
            type: 'base64',
            media_type: assertSupportedImageMimeType(block.mimeType),
            data: block.data,
          },
        }
      : { type: 'text', text: block.text },
  );
}

/**
 * Asserts a caller-supplied JSON Schema is an object schema before it's
 * used as Anthropic's `Tool.input_schema`, which (like every other
 * provider's function-calling API) requires `type: 'object'`. VernLLM's own
 * public `tools`/`jsonSchema` APIs accept freeform `Record<string,
 * unknown>` JSON Schema, so nothing upstream guarantees this at compile
 * time; this is the runtime check that stands in for that, so a schema
 * missing (or mistyping) `type: 'object'` fails loudly and immediately
 * instead of being silently forwarded to Anthropic malformed.
 */
function assertObjectSchema(
  schema: Record<string, unknown>,
  toolName: string,
): { type: 'object'; [key: string]: unknown } {
  if (schema.type !== 'object') {
    throw new LLMError(
      `Tool "${toolName}"'s schema must have "type": "object" (Anthropic requires object-shaped tool parameters).`,
      'validation',
    );
  }

  return schema as { type: 'object'; [key: string]: unknown };
}

/**
 * Translates VernLLM's OpenAI-shaped wire `tool_choice` into Anthropic's
 * `{ type: 'auto' | 'any' | 'none' | 'tool', name? }` shape. `'required'`
 * maps to `'any'` (Anthropic's "must call some tool" equivalent).
 */
function toAnthropicToolChoice(
  toolChoice: Parameters<LLMClient['chat']['completions']['create']>[0]['tool_choice'],
):
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'none' }
  | { type: 'tool'; name: string }
  | undefined {
  if (!toolChoice || toolChoice === 'auto') return { type: 'auto' };
  if (toolChoice === 'none') return { type: 'none' };
  if (toolChoice === 'required') return { type: 'any' };

  return { type: 'tool', name: toolChoice.function.name };
}

/** One SSE event of an Anthropic `messages.create({ stream: true })` stream. */
type AnthropicStreamEvent =
  | { type: 'message_start'; message: { usage?: { input_tokens?: number } } }
  | {
      type: 'content_block_start';
      index: number;
      content_block: { type: string; id?: string; name?: string };
    }
  | {
      type: 'content_block_delta';
      index: number;
      delta:
        | { type: 'text_delta'; text: string }
        | { type: 'input_json_delta'; partial_json: string };
    }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; usage?: { output_tokens?: number } }
  | { type: 'message_stop' }
  // Keep-alive event during long streams (e.g. extended thinking). Modeled
  // so the event switch has somewhere to route it. See createStream.
  | { type: 'ping' };

type AnthropicRequestBody = Parameters<AnthropicClient['messages']['create']>[0];

/**
 * Maps VernLLM's OpenAI-shaped wire `tools`/`tool_choice` into Anthropic's
 * `tools`/`tool_choice` shape. Shared by the two call sites that build real
 * (non-schema-forced) tool definitions: the plain tools-only branch, and
 * the native-structured-output branch, which sends real tools alongside
 * `output_config` rather than instead of it.
 */
function buildAnthropicTools(
  tools: NonNullable<Parameters<LLMClient['chat']['completions']['create']>[0]['tools']>,
  toolChoiceParam: Parameters<LLMClient['chat']['completions']['create']>[0]['tool_choice'],
): {
  tools: NonNullable<Parameters<AnthropicClient['messages']['create']>[0]['tools']>;
  toolChoice: Parameters<AnthropicClient['messages']['create']>[0]['tool_choice'];
} {
  return {
    tools: tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      // Tool parameters are always object schemas in practice (every
      // provider's function-calling API requires it).
      input_schema: assertObjectSchema(t.function.parameters, t.function.name),
    })),
    toolChoice: toAnthropicToolChoice(toolChoiceParam),
  };
}

/**
 * Builds the Anthropic-shaped request body from VernLLM's wire params,
 * shared between `create` and `createStream` so both go through identical
 * translation (system prompt, message shaping, and the jsonSchema →
 * forced-single-tool mapping all happen exactly once, not once per entry
 * point).
 *
 * Returns `toolName` alongside the body: when set, the model was forced to
 * call a single synthetic tool standing in for `jsonSchema` output (the
 * legacy path, for models without native structured-output support), and
 * both `create` and `createStream` need to know this so they can unwrap
 * that tool call back into plain text content instead of treating it like
 * a real tool call. On the native path (model supports `output_config`),
 * `toolName` is `undefined`: the schema-conforming JSON already arrives as
 * ordinary text content, nothing to unwrap, and any real tool calls in
 * `params.tools` are left for the normal, non-forced tool-call handling
 * both `create` and `createStream` already do when `toolName` is unset.
 */
function buildAnthropicRequestBody(
  params: Parameters<LLMClient['chat']['completions']['create']>[0],
  nativeStructuredOutputModels?: ModelCapabilityOverride,
): { body: AnthropicRequestBody; toolName: string | undefined } {
  const systemMessage = params.messages.find((m) => m.role === 'system');

  // Keep user, assistant, and tool turns, in order. Anthropic has no
  // separate 'tool' role: tool results travel as a user-role message
  // containing tool_result content blocks, and an assistant's tool
  // requests travel as tool_use content blocks on its own turn.
  const conversationMessages = params.messages.filter(
    (m) => m.role === 'user' || m.role === 'assistant' || m.role === 'tool',
  );

  const jsonSchema =
    params.response_format?.type === 'json_schema' ? params.response_format.json_schema : undefined;

  const schemaName = jsonSchema?.name.trim();

  if (jsonSchema && !schemaName) {
    throw new LLMError('json_schema.name must not be empty.', 'validation');
  }

  const isNative =
    Boolean(jsonSchema) &&
    supportsNativeStructuredOutput(params.model, nativeStructuredOutputModels);

  if (jsonSchema && params.tools?.length && !isNative) {
    throw new LLMError(
      `Anthropic model "${params.model}" is not covered by nativeStructuredOutputModels, so ` +
        '`jsonSchema` is emulated as a forced single tool call there, which collides with the ' +
        '`tools` you also provided. Either drop `tools` or `jsonSchema` for this call, or pass ' +
        "this model in fromAnthropic's `nativeStructuredOutputModels` option once you've " +
        "confirmed it supports Anthropic's `output_config.format`.",
      'validation',
    );
  }

  let toolName: string | undefined;
  let jsonInstruction: string | undefined;
  let outputFormat: NonNullable<AnthropicRequestBody['output_config']>['format'] | undefined;
  let tools: NonNullable<Parameters<AnthropicClient['messages']['create']>[0]['tools']> | undefined;
  let toolChoice: Parameters<AnthropicClient['messages']['create']>[0]['tool_choice'];

  if (jsonSchema && isNative) {
    // Native path: the schema goes in its own request field, independent
    // of tools/tool_choice, so real tools (if any) are built exactly like
    // the tools-only branch below and sent alongside it.
    //
    // Only `type` and `schema` are sent: the real Anthropic API's
    // `output_config.format` has no `name`/`description`/`strict` fields,
    // unlike the legacy forced-tool-call path below, where those are real
    // `Tool` fields. `schemaName` is still required and validated above
    // (a caller-facing identifier, useful for logging/debugging on their
    // end), it just never reaches this particular wire request.
    outputFormat = { type: 'json_schema', schema: jsonSchema.schema };

    if (params.tools?.length) {
      ({ tools, toolChoice } = buildAnthropicTools(params.tools, params.tool_choice));
    }
  } else if (jsonSchema && schemaName) {
    // Legacy path: jsonSchema alone (or with tools, on a native model — see
    // above), on a model without native support, becomes a forced single
    // tool call, unchanged from before this adapter had a native path.
    const { schema, description, strict } = jsonSchema;

    toolName = schemaName;
    // VernLLM's public `jsonSchema` API accepts a freeform JSON Schema
    // object (`Record<string, unknown>`), not necessarily typed with a
    // literal `type: 'object'`, but tool/function parameters are always
    // object schemas in practice (every provider's function-calling API
    // requires it), so this assertion reflects that existing convention
    // rather than changing behavior.
    tools = [
      { name: toolName, description, input_schema: assertObjectSchema(schema, toolName), strict },
    ];
    toolChoice = { type: 'tool', name: toolName };
  } else if (params.response_format?.type === 'json_object') {
    // No schema to build a tool from, fall back to a prompt instruction.
    // This does not exclude real `tools`: `json_object` mode is just a
    // system-prompt nudge, not a request field that could collide with
    // `tools`/`tool_choice`, so both are set independently below.
    jsonInstruction = 'Respond with valid JSON only, no prose or markdown fences.';
  }

  if (!jsonSchema && params.tools?.length) {
    ({ tools, toolChoice } = buildAnthropicTools(params.tools, params.tool_choice));
  }

  // `reasoning_effort` (OpenAI o-series/gpt-5 style) has no direct Anthropic
  // equivalent. Claude's extended thinking uses a token budget, not a tier
  // string, so it's intentionally dropped here rather than guessed at.

  const system = [systemMessage?.content, jsonInstruction].filter(Boolean).join('\n\n');

  const body: AnthropicRequestBody = {
    model: params.model,
    max_tokens: params.max_tokens,
    ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
    system: system || undefined,
    messages: mergeConsecutiveToolResults(conversationMessages.map((m) => toAnthropicMessage(m))),
    ...(tools ? { tools, tool_choice: toolChoice } : {}),
    ...(outputFormat ? { output_config: { format: outputFormat } } : {}),
  };

  return { body, toolName };
}

/** Optional configuration for `fromAnthropic`. */
export interface AnthropicAdapterOptions {
  /**
   * Which models support native, schema-constrained output
   * (`output_config.format`), independent of `tools`/`tool_choice`, so it
   * can be combined with real `tools` in one request. Pass a static list
   * of model IDs (verified against Anthropic's own docs) or a predicate.
   *
   * There is no built-in default here (see `supportsNativeStructuredOutput`
   * for why). Left unset, every model uses the older forced-single-tool-
   * call emulation, and `tools` + `jsonSchema` together is rejected,
   * exactly this adapter's behavior before native support was added.
   */
  nativeStructuredOutputModels?: ModelCapabilityOverride;
}

/**
 * Wraps an Anthropic SDK client so it satisfies the same `LLMClient`
 * interface VernLLM uses for OpenAI/Groq.
 *
 * `response_format: json_schema`, on a model covered by
 * `options.nativeStructuredOutputModels`, is sent as `output_config.format`,
 * its own request field, independent of `tools`/`tool_choice`, so it can be
 * combined with real, caller-supplied `tools` in the same request. Only
 * `type` and `schema` are sent on this path, the real Anthropic API's
 * `output_config.format` has no `name`/`description`/`strict` fields.
 *
 * On any other model (the default, since `nativeStructuredOutputModels` is
 * opt-in), `response_format: json_schema` is mapped to Anthropic's forced
 * tool-use instead: a single tool is defined with `input_schema` set to
 * the caller's schema, `description` forwarded when provided, and `strict`
 * forwarded when set, and `tool_choice` forces the model to call it. This
 * legacy path cannot be combined with real `tools` (both would need the
 * same `tools`/`tool_choice` field), and a call that tries throws
 * `LLMError('validation')` before reaching the API. Provider-constrained
 * schema matching applies only when `strict: true` is forwarded and
 * supported.
 *
 * `response_format: json_object` (no schema to build a tool from) falls
 * back to a system-prompt instruction, since there's nothing to constrain
 * generation against. Unlike `jsonSchema`, this combines with real `tools`
 * freely on every model: it's a prompt nudge, not a request field, so
 * there's nothing for it to collide with.
 */
export function fromAnthropic(
  anthropicClient: AnthropicClient,
  options?: AnthropicAdapterOptions,
): LLMClient {
  const nativeStructuredOutputModels = options?.nativeStructuredOutputModels;
  // The Anthropic SDK's `messages.create`, called with `stream: true`,
  // returns an AsyncIterable of `AnthropicStreamEvent` rather than
  // `AnthropicClient['messages']['create']`'s normal single-message return
  // type, hence `unknown` here and a cast at the call site, same
  // rationale as `fromOpenAICompatible`'s `rawCreate`: the wire contract,
  // not the SDK's own TS types, is what's actually relied on.
  const rawMessagesCreate = anthropicClient.messages.create.bind(
    anthropicClient.messages,
  ) as unknown as (
    params: unknown,
    options: { signal: AbortSignal },
  ) => Promise<unknown> | AsyncIterable<AnthropicStreamEvent>;

  return {
    chat: {
      completions: {
        async create(params, options) {
          const { body, toolName } = buildAnthropicRequestBody(
            params,
            nativeStructuredOutputModels,
          );

          const response = await anthropicClient.messages.create(body, options);

          let text: string;
          let wireToolCalls: WireToolCall[] | undefined;
          if (toolName) {
            const toolUse = response.content.find(
              (block) => block.type === 'tool_use' && block.name === toolName,
            );

            if (!toolUse) {
              throw new LLMError(
                `Anthropic did not return the required structured output tool "${toolName}".`,
                'validation',
              );
            }

            if (
              !toolUse.input ||
              typeof toolUse.input !== 'object' ||
              Array.isArray(toolUse.input)
            ) {
              throw new LLMError(
                `Anthropic returned invalid structured output for tool "${toolName}". Expected an object.`,
                'validation',
              );
            }

            text = JSON.stringify(toolUse.input);
          } else {
            text = response.content
              .filter((block) => block.type === 'text')
              .map((block) => block.text ?? '')
              .join('');

            const toolUses = response.content.filter((block) => block.type === 'tool_use');

            if (toolUses.length) {
              wireToolCalls = toolUses.map((block) => ({
                id: block.id!,
                type: 'function' as const,
                function: { name: block.name!, arguments: JSON.stringify(block.input ?? {}) },
              }));
            }
          }

          return {
            choices: [
              {
                message: { content: text, ...(wireToolCalls ? { tool_calls: wireToolCalls } : {}) },
              },
            ],
            usage: {
              prompt_tokens: response.usage?.input_tokens,
              completion_tokens: response.usage?.output_tokens,
              total_tokens:
                (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0),
            },
          };
        },

        async *createStream(params, options) {
          const { body, toolName } = buildAnthropicRequestBody(
            params,
            nativeStructuredOutputModels,
          );

          const stream = (await rawMessagesCreate(
            { ...body, stream: true },
            options,
          )) as AsyncIterable<AnthropicStreamEvent>;

          // Tracks which content-block index is which kind, since Anthropic
          // interleaves text and tool_use blocks under a shared `index`
          // sequence and later delta events only carry that index, not the
          // kind. `json-tool` is the forced single-tool-call standing in
          // for `jsonSchema` output (see `toolName` above): its
          // input_json_delta fragments are re-emitted as `text-delta`, not
          // `tool_call_delta`, so the accumulated result lands in
          // finalizeResponse's `content` path exactly like the
          // non-streaming `create` branch above unwraps it.
          const blockKinds = new Map<number, 'text' | 'tool_use' | 'json-tool'>();
          let inputTokens = 0;
          let sawJsonTool = false;

          for await (const event of stream) {
            if (event.type === 'message_start') {
              inputTokens = event.message.usage?.input_tokens ?? 0;
            } else if (event.type === 'content_block_start') {
              if (event.content_block.type === 'tool_use') {
                const kind = event.content_block.name === toolName ? 'json-tool' : 'tool_use';

                blockKinds.set(event.index, kind);

                if (kind === 'json-tool') {
                  sawJsonTool = true;
                } else if (!toolName) {
                  // Only surface tool_use blocks as tool_call_delta chunks
                  // when there's no forced structured-output tool in play.
                  // When `toolName` is set, any non-matching tool_use block
                  // is unexpected (Anthropic forces exactly one tool), and
                  // surfacing it would corrupt the caller's expectation of
                  // receiving only the forced tool's JSON payload as text.
                  yield {
                    type: 'tool_call_delta',
                    index: event.index,
                    id: event.content_block.id,
                    name: event.content_block.name,
                  };
                }
              } else {
                blockKinds.set(event.index, 'text');
              }
            } else if (event.type === 'content_block_delta') {
              if (event.delta.type === 'text_delta') {
                // Only surfaced as real content when there's no forced
                // json-schema tool in play. When `toolName` is set, the
                // *only* content that should end up in the accumulated
                // text is the forced tool's own JSON payload (its
                // input_json_delta fragments, handled below), exactly
                // what the non-streaming `create` branch above does by
                // discarding every content block except the matching
                // tool_use one. Anthropic can still emit genuine text
                // blocks alongside a forced tool call (a model narrating
                // before calling it, say), and without this guard those
                // would get concatenated into the same buffer as the
                // tool's JSON, corrupting it.
                if (!toolName) {
                  yield { type: 'text-delta', delta: event.delta.text };
                }
              } else if (event.delta.type === 'input_json_delta') {
                const kind = blockKinds.get(event.index);

                if (kind === 'json-tool') {
                  yield { type: 'text-delta', delta: event.delta.partial_json };
                } else if (!toolName) {
                  yield {
                    type: 'tool_call_delta',
                    index: event.index,
                    argumentsDelta: event.delta.partial_json,
                  };
                }
              }
            } else if (event.type === 'message_delta') {
              const outputTokens = event.usage?.output_tokens ?? 0;

              yield {
                type: 'usage',
                usage: {
                  prompt_tokens: inputTokens,
                  completion_tokens: outputTokens,
                  total_tokens: inputTokens + outputTokens,
                },
              } satisfies WireStreamChunk;
            } else if (event.type === 'ping') {
              // Keep-alive with no content. Yielding it resets the
              // idle-timeout clock in VernLLM's stream loop.
              yield { type: 'ping' };
            }
          }

          if (toolName && !sawJsonTool) {
            throw new LLMError(
              `Anthropic did not return the required structured output tool "${toolName}".`,
              'validation',
            );
          }
        },
      },
    },
  };
}

/**
 * Anthropic requires strict role alternation, so the per-wire-message
 * mapping above (one `{role:'user', content:[tool_result]}` per VernLLM
 * wire tool message) needs merging back together when an assistant turn
 * requested more than one tool: multiple consecutive user turns would
 * violate that alternation, and Anthropic's API rejects it outright. This
 * merges any run of tool-result-only user messages into one, with all
 * their tool_result blocks combined, the shape Anthropic expects for "here
 * are the results of everything you just asked for."
 */
function mergeConsecutiveToolResults(
  messages: { role: 'user' | 'assistant'; content: string | AnthropicContentBlock[] }[],
): { role: 'user' | 'assistant'; content: string | AnthropicContentBlock[] }[] {
  const isToolResultOnly = (
    m: (typeof messages)[number],
  ): m is { role: 'user'; content: AnthropicContentBlock[] } =>
    m.role === 'user' &&
    Array.isArray(m.content) &&
    m.content.length > 0 &&
    m.content.every((b) => b.type === 'tool_result');

  const merged: (typeof messages)[number][] = [];

  for (const m of messages) {
    const prev = merged.at(-1);

    if (isToolResultOnly(m) && prev && isToolResultOnly(prev)) {
      prev.content.push(...m.content);
    } else {
      merged.push(m);
    }
  }

  return merged;
}

/**
 * Translates one VernLLM wire message (OpenAI-shaped: plain user/assistant
 * turns, an assistant turn with `tool_calls`, or a `tool` turn) into
 * Anthropic's `{ role: 'user' | 'assistant', content }` shape.
 */
function toAnthropicMessage(
  m: Extract<
    Parameters<LLMClient['chat']['completions']['create']>[0]['messages'][number],
    { role: 'user' | 'assistant' | 'tool' }
  >,
): { role: 'user' | 'assistant'; content: string | AnthropicContentBlock[] } {
  if (m.role === 'tool') {
    // Anthropic has no 'tool' role: results travel as a user turn with
    // tool_result blocks.
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: m.tool_call_id,
          content: m.content,
          ...(m.is_error ? { is_error: true } : {}),
        },
      ],
    };
  }

  if (m.role === 'assistant' && m.tool_calls?.length) {
    const blocks: AnthropicContentBlock[] = [];

    if (m.content) blocks.push({ type: 'text', text: m.content });

    for (const tc of m.tool_calls) {
      let input: unknown;

      try {
        input = tc.function.arguments.trim() ? JSON.parse(tc.function.arguments) : {};
      } catch (cause) {
        throw new LLMError(
          `Assistant tool call "${tc.function.name}" (${tc.id}) has arguments that are not valid JSON.`,
          'validation',
          { cause },
        );
      }

      if (input === null || Array.isArray(input) || typeof input !== 'object') {
        throw new LLMError(
          `Assistant tool call "${tc.function.name}" (${tc.id}) arguments must be a JSON object.`,
          'validation',
        );
      }

      blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
    }

    return { role: 'assistant', content: blocks };
  }

  return {
    role: m.role,
    content: Array.isArray(m.content) ? toAnthropicContent(m.content) : (m.content ?? ''),
  };
}

import { assertSupportedImageMimeType } from '../internal/imageFormat.js';
import { LLMError, type ContentBlock, type LLMClient, type WireToolCall } from '../types/index.js';

/** Anthropic's native per-block content shape for a message. */
type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
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
          input_schema: Record<string, unknown>;
          strict?: boolean;
        }>;
        tool_choice?: { type: 'tool' | 'auto' | 'any' | 'none'; name?: string };
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
 * Wraps an Anthropic SDK client so it satisfies the same `LLMClient`
 * interface VernLLM uses for OpenAI/Groq.
 *
 * `response_format: json_schema` is mapped to Anthropic's forced tool-use:
 * a single tool is defined with `input_schema` set to the caller's schema,
 * `description` forwarded when provided, and `strict` forwarded when set.
 * `tool_choice` forces the model to call it. Provider-constrained schema
 * matching applies only when `strict: true` is forwarded and supported.
 *
 * `response_format: json_object` (no schema to build a tool from) falls
 * back to a system-prompt instruction, since there's nothing to constrain
 * generation against.
 */
/**
 * Translates VernLLM's OpenAI-shaped wire `tool_choice` into Anthropic's
 * `{ type: 'auto' | 'any' | 'none' | 'tool', name? }` shape. `'required'`
 * maps to `'any'` (Anthropic's "must call some tool" equivalent).
 */
function toAnthropicToolChoice(
  toolChoice: Parameters<LLMClient['chat']['completions']['create']>[0]['tool_choice'],
): { type: 'tool' | 'auto' | 'any' | 'none'; name?: string } | undefined {
  if (!toolChoice || toolChoice === 'auto') return { type: 'auto' };
  if (toolChoice === 'none') return { type: 'none' };
  if (toolChoice === 'required') return { type: 'any' };

  return { type: 'tool', name: toolChoice.function.name };
}

export function fromAnthropic(anthropicClient: AnthropicClient): LLMClient {
  return {
    chat: {
      completions: {
        async create(params, options) {
          const systemMessage = params.messages.find((m) => m.role === 'system');

          // Keep user, assistant, and tool turns, in order. Anthropic has no
          // separate 'tool' role: tool results travel as a user-role message
          // containing tool_result content blocks, and an assistant's tool
          // requests travel as tool_use content blocks on its own turn.
          const conversationMessages = params.messages.filter(
            (m) => m.role === 'user' || m.role === 'assistant' || m.role === 'tool',
          );

          const toolName =
            params.response_format?.type === 'json_schema'
              ? params.response_format.json_schema.name.trim()
              : undefined;

          if (params.response_format?.type === 'json_schema' && !toolName) {
            throw new LLMError('json_schema.name must not be empty.', 'validation');
          }

          let jsonInstruction: string | undefined;
          let tools:
            | NonNullable<Parameters<AnthropicClient['messages']['create']>[0]['tools']>
            | undefined;
          let toolChoice: Parameters<AnthropicClient['messages']['create']>[0]['tool_choice'];

          if (params.response_format?.type === 'json_schema' && toolName) {
            // jsonSchema and real `tools` are mutually exclusive by the time
            // a call reaches here (enforced in vernLLM.ts), so this branch
            // and the `params.tools` branch below never both apply.
            const { schema, description, strict } = params.response_format.json_schema;

            tools = [{ name: toolName, description, input_schema: schema, strict }];
            toolChoice = { type: 'tool', name: toolName };
          } else if (params.response_format?.type === 'json_object') {
            // No schema to build a tool from, fall back to a prompt instruction
            jsonInstruction = 'Respond with valid JSON only, no prose or markdown fences.';
          } else if (params.tools?.length) {
            tools = params.tools.map((t) => ({
              name: t.function.name,
              description: t.function.description,
              input_schema: t.function.parameters,
            }));
            toolChoice = toAnthropicToolChoice(params.tool_choice);
          }

          // `reasoning_effort` (OpenAI o-series/gpt-5 style) has no direct Anthropic
          // equivalent. Claude's extended thinking uses a token budget, not a tier
          // string, so it's intentionally dropped here rather than guessed at.

          const system = [systemMessage?.content, jsonInstruction].filter(Boolean).join('\n\n');

          const response = await anthropicClient.messages.create(
            {
              model: params.model,
              max_tokens: params.max_tokens,
              ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
              system: system || undefined,
              messages: mergeConsecutiveToolResults(
                conversationMessages.map((m) => toAnthropicMessage(m)),
              ),
              ...(tools ? { tools, tool_choice: toolChoice } : {}),
            },
            options,
          );

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
          undefined,
          undefined,
          cause,
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

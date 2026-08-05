import { assertSupportedImageMimeType } from '../internal/imageFormat.js';
import { LLMError, type ContentBlock, type LLMClient, type WireToolCall } from '../types/index.js';

/** Gemini's native per-part content shape for a `contents` entry. */
type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { name: string; args: unknown } }
  | { functionResponse: { name: string; response: unknown } };

/**
 * Minimal structural type for VernLLM's two-argument wrapper around Gemini
 * `generateContent`. The wrapper exposes a request shape aligned with the
 * adapter interface, with top-level `systemInstruction` and
 * `generationConfig` fields, while transport options (such as `AbortSignal`)
 * are passed separately as the second argument.
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
      tools?: Array<{
        functionDeclarations: Array<{
          name: string;
          description?: string;
          parameters: Record<string, unknown>;
        }>;
      }>;
      toolConfig?: {
        functionCallingConfig: {
          mode: 'AUTO' | 'ANY' | 'NONE';
          allowedFunctionNames?: string[];
        };
      };
    },
    options: { signal: AbortSignal },
  ): Promise<{
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string; functionCall?: { name: string; args: unknown } }>;
      };
    }>;
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
): NonNullable<Parameters<GeminiClient['generateContent']>[0]['toolConfig']> {
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
    throw new LLMError(
      `Tool call "${toolName}" arguments are not valid JSON.`,
      'validation',
      undefined,
      undefined,
      cause,
    );
  }

  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new LLMError(`Tool call "${toolName}" arguments must be a JSON object.`, 'validation');
  }

  return parsed as Record<string, unknown>;
}

function parseToolResult(text: string): unknown {
  try {
    return text.trim() ? JSON.parse(text) : '';
  } catch {
    return text;
  }
}

/**
 * Gemini expects the results of everything the model asked for in one
 * turn to arrive together as multiple `functionResponse` parts on a
 * single `'user'` entry — not as separate consecutive `'user'` entries.
 * The per-wire-message mapping above produces one `'user'` entry per
 * VernLLM wire tool message, so when an assistant turn requested more
 * than one tool, this merges the resulting run of
 * functionResponse-only `'user'` entries back into one.
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
 * `tool_choice` maps to `toolConfig.functionCallingConfig`. `jsonSchema`
 * and `tools` are mutually exclusive by the time a call reaches here
 * (enforced in vernLLM.ts), so `responseSchema` and `tools` never
 * both apply.
 */
export function fromGemini(geminiClient: GeminiClient): LLMClient {
  return {
    chat: {
      completions: {
        async create(params, options) {
          const systemMessage = params.messages.find((m) => m.role === 'system');
          // Keep user, assistant, and tool turns, in order.
          const conversationMessages = params.messages.filter(
            (m) => m.role === 'user' || m.role === 'assistant' || m.role === 'tool',
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
            const { schema, description } = params.response_format.json_schema;

            generationConfig.responseSchema = {
              ...schema,
              ...(description ? { description } : {}),
            };
          }

          const tools = params.tools?.length
            ? [
                {
                  functionDeclarations: params.tools.map((t) => ({
                    name: t.function.name,
                    description: t.function.description,
                    parameters: t.function.parameters,
                  })),
                },
              ]
            : undefined;

          const response = await geminiClient.generateContent(
            {
              model: params.model,
              contents: mergeConsecutiveFunctionResponses(
                conversationMessages.map((m) => toGeminiContent(m)),
              ),
              systemInstruction: systemMessage
                ? // System turns are always plain strings; only user turns can carry ContentBlock[]
                  { parts: [{ text: systemMessage.content as string }] }
                : undefined,
              generationConfig,
              ...(tools ? { tools, toolConfig: toGeminiToolConfig(params.tool_choice) } : {}),
            },
            options,
          );

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
              // back — a real limitation of Gemini's own function-calling
              // API, not something VernLLM can paper over.
              id: p.functionCall!.name,
              type: 'function' as const,
              function: {
                name: p.functionCall!.name,
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
      },
    },
  };
}

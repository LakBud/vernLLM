import { vi } from 'vitest';

import { type AnthropicClient } from '../src/adapters/anthropic.js';
import { type LLMClient } from '../src/types/index.js';

type CreateResult = Awaited<ReturnType<LLMClient['chat']['completions']['create']>>;
type CreateParams = Parameters<LLMClient['chat']['completions']['create']>[0];

/** Builds a successful chat-completion response with the given JSON-serializable body. */
export function jsonResponse(
  body: unknown,
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number },
): CreateResult {
  return {
    choices: [{ message: { content: JSON.stringify(body) } }],
    usage,
  };
}

/** Builds a successful chat-completion response with raw text content. */
export function textResponse(text: string): CreateResult {
  return { choices: [{ message: { content: text } }] };
}

/** Builds a response where the model requests one or more tool calls. */
export function toolCallResponse(
  calls: Array<{ id: string; name: string; arguments: unknown; rawArguments?: string }>,
  content?: string,
): CreateResult {
  return {
    choices: [
      {
        message: {
          content: content ?? null,
          tool_calls: calls.map((c) => ({
            id: c.id,
            type: 'function' as const,
            function: {
              name: c.name,
              arguments: c.rawArguments ?? JSON.stringify(c.arguments),
            },
          })),
        },
      },
    ],
  };
}

/** An error carrying an HTTP-style status, as SDK errors typically do. */
export class FakeApiError extends Error {
  headers?: { get(name: string): string | null };

  constructor(
    message: string,
    public status: number,
    headers?: Record<string, string>,
  ) {
    super(message);
    if (headers) {
      const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
      this.headers = { get: (name: string) => map.get(name.toLowerCase()) ?? null };
    }
  }
}

/**
 * A scriptable mock LLMClient. Each entry in `script` is either a response
 * (or a function producing one, sync or async — useful for reading params or
 * respecting the abort signal) or an Error to throw for that call.
 * Calls beyond the script length reuse the last entry.
 */
export function createMockClient(
  script: Array<
    | CreateResult
    | Error
    | ((params: CreateParams, signal: AbortSignal) => CreateResult | Promise<CreateResult>)
  >,
) {
  const calls: CreateParams[] = [];
  let i = 0;

  const create = vi.fn(async (params: CreateParams, options: { signal: AbortSignal }) => {
    calls.push(params);
    const entry = script[Math.min(i, script.length - 1)];
    i++;

    if (entry === undefined) {
      throw new Error('createMockClient: script is empty');
    }

    if (entry instanceof Error) {
      throw entry;
    }
    if (typeof entry === 'function') {
      return entry(params, options.signal);
    }
    return entry;
  });

  const client: LLMClient = { chat: { completions: { create } } };
  return { client, create, calls };
}

/** Non-null indexed access for arrays, for use with noUncheckedIndexedAccess. */
export function at<T>(arr: readonly T[], index: number): T {
  const value = arr[index];
  if (value === undefined) {
    throw new Error(`Expected element at index ${index}, but array has length ${arr.length}`);
  }
  return value;
}

export function makeFakeAnthropicClient(
  responseText: string,
  usage = { input_tokens: 10, output_tokens: 5 },
) {
  const create = vi.fn<AnthropicClient['messages']['create']>(async () => ({
    content: [{ type: 'text', text: responseText }],
    usage,
  }));

  return { client: { messages: { create } }, create };
}

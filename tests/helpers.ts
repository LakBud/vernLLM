import { vi } from 'vitest';

import type { LLMClient } from '../src/types.js';

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

/** An error carrying an HTTP-style status, as SDK errors typically do. */
export class FakeApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
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
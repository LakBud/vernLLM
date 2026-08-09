import { vi } from 'vitest';

import { type AnthropicClient } from '../src/adapters/anthropic.js';
import { StreamChunk, type LLMClient, type WireStreamChunk } from '../src/types/index.js';
import { type VernLLM } from '../src/vernLLM.js';

import type { InternalCacheParams } from '../src/internal/cache.utils.js';

/**
 * `runCached` is a private implementation primitive backing the public
 * `cachedCall()`. These tests exercise it directly rather than through
 * `any`.
 */
export type TestableVernLLM = Omit<VernLLM, 'runCached'> & {
  runCached: <T>(params: InternalCacheParams<T>) => Promise<T>;
};

export function asTestable(llm: VernLLM): TestableVernLLM {
  return llm as unknown as TestableVernLLM;
}

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
 * (or a function producing one, sync or async, useful for reading params or
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

/**
 * Builds a hand-rolled `LLMClient` whose `createStream` yields a scripted
 * sequence of `WireStreamChunk`s per call (no real adapter needed, proves
 * the core streaming plumbing in isolation, per the streaming design's
 * implementation order).
 */
export function createMockStreamingClient(
  script: Array<WireStreamChunk[] | Error | (() => AsyncIterable<WireStreamChunk>)>,
) {
  const calls: CreateParams[] = [];
  let i = 0;

  const createStream = vi.fn(
    (params: CreateParams, _options: { signal: AbortSignal }): AsyncIterable<WireStreamChunk> => {
      calls.push(params);
      const entry = script[Math.min(i, script.length - 1)];
      i++;

      if (entry === undefined) {
        throw new Error('createMockStreamingClient: script is empty');
      }

      if (entry instanceof Error) {
        const err = entry;
        return {
          [Symbol.asyncIterator]() {
            return {
              next(): Promise<IteratorResult<WireStreamChunk>> {
                return Promise.reject(err);
              },
            };
          },
        };
      }

      if (typeof entry === 'function') {
        return entry();
      }

      const chunks = entry;

      return {
        [Symbol.asyncIterator]() {
          let index = 0;

          return {
            async next(): Promise<IteratorResult<WireStreamChunk>> {
              if (index >= chunks.length) {
                return { done: true, value: undefined };
              }

              const value = chunks[index];
              index++;

              return { done: false, value: value! };
            },
          };
        },
      };
    },
  );

  // No non-streaming `create` implemented, these mocks are for
  // `stream: true` tests only.
  const create = vi.fn(async () => {
    throw new Error('createMockStreamingClient: create() was not scripted');
  });

  const client: LLMClient = { chat: { completions: { create, createStream } } };
  return { client, createStream, calls };
}

/** Non-null indexed access for arrays, for use with noUncheckedIndexedAccess. */
export function at<T>(arr: readonly T[], index: number): T {
  const value = arr[index];
  if (value === undefined) {
    throw new Error(`Expected element at index ${index}, but array has length ${arr.length}`);
  }
  return value;
}

/** A fake `ReadableStream<Uint8Array>`, as `response.body` would be. */
export function fakeReadableStream(parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;

  return new ReadableStream({
    pull(controller) {
      if (index >= parts.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(parts[index]));
      index++;
    },
  });
}

/**
 * Builds a `createMockStreamingClient` factory-style script entry (the
 * `() => AsyncIterable<WireStreamChunk>` variant) that yields `chunks` and
 * then throws `failure` from `next()`, with an iterator whose `return()`
 * implementation calls `onReturn`, so tests can exercise
 * `buildStreamResult`'s cleanup path (`iterator.return?.()`, called when
 * the pump loop's try/catch handles a processing-time throw) instead of
 * skipping it. If `onReturn` throws or its returned promise rejects,
 * `return()` itself rejects with that error, exercising the
 * swallow-on-cleanup-failure branch in the same pump loop.
 */
export function scriptedIteratorWithReturn(
  chunks: WireStreamChunk[],
  failure: unknown,
  onReturn: () => void | Promise<void> = () => {},
): () => AsyncIterable<WireStreamChunk> {
  return () => ({
    [Symbol.asyncIterator]() {
      let index = 0;

      return {
        async next(): Promise<IteratorResult<WireStreamChunk>> {
          if (index >= chunks.length) {
            throw failure;
          }

          const value = chunks[index];
          index++;

          return { done: false, value: value! };
        },
        async return(): Promise<IteratorResult<WireStreamChunk>> {
          await onReturn();
          return { done: true, value: undefined };
        },
      };
    },
  });
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

/** Collects all chunks from an async stream for assertions. */
export async function drain(chunks: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of chunks) out.push(chunk);
  return out;
}

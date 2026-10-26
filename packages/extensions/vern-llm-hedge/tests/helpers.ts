import { vi } from 'vitest';

import type { LLMClient, Logger, VernLLMOptions, WireStreamChunk } from 'vern-llm';

// Copied from the other extension packages on purpose, so the packages stay independent of each
// other and of the core's own test files.

type CreateResult = Awaited<ReturnType<LLMClient['chat']['completions']['create']>>;
type CreateParams = Parameters<LLMClient['chat']['completions']['create']>[0];

export function textResponse(text: string): CreateResult {
  return { choices: [{ message: { content: text } }] };
}

/** Each entry is a response or an error for that call. Calls past the end reuse the last entry. */
export function createMockClient(script: (CreateResult | Error)[]) {
  const calls: CreateParams[] = [];
  let index = 0;

  const client: LLMClient = {
    chat: {
      completions: {
        create: async (params: CreateParams) => {
          calls.push(params);
          const entry = script[Math.min(index, script.length - 1)];
          index++;

          /* v8 ignore next */
          if (entry === undefined) throw new Error('createMockClient: script is empty');
          if (entry instanceof Error) throw entry;
          return entry;
        },
      },
    },
  };

  return { client, calls };
}

/** One request a held client has received and not yet answered. */
export interface HeldRequest {
  /**
   * Answers the request with `text`, reporting `promptTokens` of usage when given, `cachedTokens`
   * of them read from the provider's cache.
   */
  answer(text?: string, promptTokens?: number, cachedTokens?: number): void;
  /** Fails the request with `error`. */
  fail(error: Error): void;
  /** Whether the core cancelled this request, which a real provider would see as a closed call. */
  readonly aborted: boolean;
  /** What the provider was sent. */
  readonly params: CreateParams;
}

/**
 * A client that answers nothing until the test says so, which makes "slow" deterministic: no
 * timers, no race. It rejects when the core cancels a request, like a provider SDK given a signal.
 */
export function heldClient(name: string) {
  const requests: HeldRequest[] = [];

  const client: LLMClient = {
    chat: {
      completions: {
        create: (params: CreateParams, options: { signal: AbortSignal }) =>
          new Promise<CreateResult>((resolve, reject) => {
            const request = {
              params,
              aborted: false,
              answer: (text: string = name, promptTokens?: number, cachedTokens?: number) =>
                resolve(
                  promptTokens === undefined
                    ? textResponse(text)
                    : {
                        ...textResponse(text),
                        usage: {
                          prompt_tokens: promptTokens,
                          completion_tokens: 5,
                          total_tokens: promptTokens + 5,
                          ...(cachedTokens !== undefined && {
                            prompt_tokens_details: { cached_tokens: cachedTokens },
                          }),
                        },
                      },
                ),
              fail: (error: Error) => reject(error),
            };
            requests.push(request);

            options.signal.addEventListener(
              'abort',
              () => {
                request.aborted = true;
                reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
              },
              { once: true },
            );
          }),
      },
    },
  };

  return { client, requests };
}

/** One stream a held stream client has opened and not yet started. */
export interface HeldStream {
  /** Starts the stream: it yields `text` as one chunk and ends. */
  open(text?: string): void;
  /** Fails the stream before its first chunk. */
  fail(error: Error): void;
  /** Whether the core cancelled this stream, which a real provider would see as a closed call. */
  readonly aborted: boolean;
}

/** Like `heldClient`, for `createStream`: nothing is yielded until the test opens the stream. */
export function heldStreamClient(name: string) {
  const requests: HeldStream[] = [];

  const client: LLMClient = {
    chat: {
      completions: {
        /* v8 ignore next */
        create: () => Promise.reject(new Error('heldStreamClient: create() is not scripted')),
        createStream: (_params: CreateParams, options: { signal: AbortSignal }) => {
          let start!: (text: string) => void;
          let stop!: (error: Error) => void;
          const first = new Promise<string>((resolve, reject) => {
            start = resolve;
            stop = reject;
          });
          const request = {
            aborted: false,
            open: (text: string = name) => start(text),
            fail: (error: Error) => stop(error),
          };
          requests.push(request);

          options.signal.addEventListener(
            'abort',
            () => {
              request.aborted = true;
              stop(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            },
            { once: true },
          );

          return (async function* (): AsyncGenerator<WireStreamChunk> {
            yield { type: 'text-delta', delta: await first };
          })();
        },
      },
    },
  };

  return { client, requests };
}

/** A client that is either scripted or held, so a test can mix both across targets. */
type Entry = LLMClient | (CreateResult | Error)[];

function isClient(entry: Entry | undefined): entry is LLMClient {
  return entry !== undefined && !Array.isArray(entry);
}

/**
 * Three targets named `primary`, `b` and `c`. Each entry is a script of responses and errors, or
 * a ready client such as `heldClient(...).client`. Spread `options` into `new VernLLM`. `tried`
 * reports every request, in the order the targets received them.
 */
export function targetChain(entries: { primary?: Entry; b?: Entry; c?: Entry } = {}) {
  const tried: string[] = [];

  const make = (name: string, entry: Entry | undefined) => {
    const mock = isClient(entry)
      ? { client: entry, calls: [] as CreateParams[] }
      : createMockClient(entry ?? [textResponse(name)]);
    const create = mock.client.chat.completions.create;
    mock.client.chat.completions.create = ((...args: Parameters<typeof create>) => {
      tried.push(name);
      return create(...args);
    }) as typeof create;
    return mock;
  };
  const primary = make('primary', entries.primary);
  const b = make('b', entries.b);
  const c = make('c', entries.c);

  const options: Pick<
    VernLLMOptions,
    'client' | 'model' | 'name' | 'maxRetries' | 'logger' | 'fallback'
  > = {
    client: primary.client,
    model: 'primary-model',
    name: 'primary',
    maxRetries: 0,
    logger: 'silent',
    fallback: [
      { client: b.client, model: 'b-model', name: 'b' },
      { client: c.client, model: 'c-model', name: 'c' },
    ],
  };

  return { primary, b, c, options, tried: () => tried };
}

/** A logger that records what the package says about itself, so a test can assert on it. */
export function captureLogger(): {
  logger: Logger;
  warnings: () => string[];
  errors: () => string[];
} {
  const warnings: string[] = [];
  const errors: string[] = [];
  const logger: Logger = {
    debug: vi.fn(),
    warn: (message) => {
      warnings.push(message);
    },
    error: (message) => {
      errors.push(message);
    },
  };
  return { logger, warnings: () => warnings, errors: () => errors };
}

/** Collects the custom events middleware emit, such as `hedge.decision`. */
export function eventProbe(eventName: string, name = 'events') {
  const events: unknown[] = [];
  const middleware = {
    name,
    onEvent: (event: { kind: string; name?: string; data?: unknown }) => {
      if (event.kind === 'custom' && event.name === eventName) events.push(event.data);
    },
  };
  return { middleware, events };
}

/** An error the core reads as a provider outage, so the chain falls back to its next target. */
export function serverError(): Error {
  return Object.assign(new Error('server error'), { status: 500 });
}

/** Polls until `check` is true. A held request arrives a few ticks after `call()` starts. */
export async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    /* v8 ignore next */
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** Lets pending promise callbacks and abort listeners run. */
export const settle = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The text of the last user message in what a provider was sent. */
export function lastUserText(params: CreateParams): string {
  return String(params.messages.filter((entry) => entry.role === 'user').at(-1)?.content);
}

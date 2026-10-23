import { vi } from 'vitest';

import type { LLMClient, Logger, VernLLMOptions } from 'vern-llm';

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

/**
 * Three targets named `primary`, `b` and `c`, each with its own mock client. Spread `options` into
 * `new VernLLM`. `calls` reports which targets were tried, in order.
 */
export function targetChain(
  scripts: {
    primary?: (CreateResult | Error)[];
    b?: (CreateResult | Error)[];
    c?: (CreateResult | Error)[];
  } = {},
) {
  const tried: string[] = [];
  const make = (name: string, script: (CreateResult | Error)[] | undefined) => {
    const mock = createMockClient(script ?? [textResponse(name)]);
    const create = mock.client.chat.completions.create;
    mock.client.chat.completions.create = (async (...args: Parameters<typeof create>) => {
      tried.push(name);
      return create(...args);
    }) as typeof create;
    return mock;
  };
  const primary = make('primary', scripts.primary);
  const b = make('b', scripts.b);
  const c = make('c', scripts.c);

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

/** Collects the custom events middleware emit, such as `router.decision`. */
export function eventProbe(eventName: string) {
  const events: unknown[] = [];
  const middleware = {
    name: 'events',
    onEvent: (event: { kind: string; name?: string; data?: unknown }) => {
      if (event.kind === 'custom' && event.name === eventName) events.push(event.data);
    },
  };
  return { middleware, events };
}

/** An error the core reads as a provider 429, so a rate limit cooldown starts. */
export function rateLimitError(): Error {
  return Object.assign(new Error('rate limited'), { status: 429 });
}

import { vi } from 'vitest';

import {
  memoryUsageStore,
  usageLogFields,
  type UsageLogFields,
  type Amount,
  type Scope,
  type UsageStore,
} from '../src/index.js';

import type { LLMClient, Logger, VernLLMMiddleware, WireStreamChunk } from 'vern-llm';

// Copied from the other extension packages on purpose, so the packages stay independent of each
// other and of the core's own test files.

type CreateResult = Awaited<ReturnType<LLMClient['chat']['completions']['create']>>;
type CreateParams = Parameters<LLMClient['chat']['completions']['create']>[0];

export function textResponse(text: string, usage?: CreateResult['usage']): CreateResult {
  return { choices: [{ message: { content: text } }], usage };
}

type Step =
  | CreateResult
  | Error
  | ((params: CreateParams, signal: AbortSignal) => Promise<CreateResult>);

/** Each entry is a response or an error for that call. Calls past the end reuse the last entry. */
export function createMockClient(script: Step[]) {
  const calls: CreateParams[] = [];
  let index = 0;

  const client: LLMClient = {
    chat: {
      completions: {
        create: async (params: CreateParams, options: { signal: AbortSignal }) => {
          calls.push(params);
          const entry = script[Math.min(index, script.length - 1)];
          index++;

          /* v8 ignore next */
          if (entry === undefined) throw new Error('createMockClient: script is empty');
          if (entry instanceof Error) throw entry;
          if (typeof entry === 'function') return entry(params, options.signal);
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
 * A client whose `createStream` yields the scripted chunks, or whatever the function returns for
 * the call's abort signal. `create` is not scripted.
 */
export function createMockStreamingClient(
  source: WireStreamChunk[] | ((signal: AbortSignal) => AsyncIterable<WireStreamChunk>),
) {
  const client: LLMClient = {
    chat: {
      completions: {
        create: vi
          .fn()
          .mockRejectedValue(new Error('createMockStreamingClient: create() was not scripted')),
        createStream: (_params, options) =>
          typeof source === 'function'
            ? source(options.signal)
            : {
                async *[Symbol.asyncIterator]() {
                  for (const chunk of source) yield chunk;
                },
              },
      },
    },
  };
  return { client };
}

/**
 * A real memory store that records every call, so a test can see what the middleware asked of it
 * and which reservations are still open.
 */
export function spyStore(overrides: Partial<UsageStore> = {}) {
  const inner = memoryUsageStore();
  const open = new Set<string>();
  const log: string[] = [];
  const reserved: { scopes: readonly Scope[]; amount: Amount }[] = [];

  const store: UsageStore = {
    reserve: async (scopes, amount, ttlMs) => {
      log.push('reserve');
      reserved.push({ scopes, amount });
      const outcome = await inner.reserve(scopes, amount, ttlMs);
      if (outcome.ok) open.add(outcome.id);
      return outcome;
    },
    commit: async (id, actual) => {
      log.push('commit');
      open.delete(id);
      await inner.commit(id, actual);
    },
    release: async (id) => {
      log.push('release');
      open.delete(id);
      await inner.release(id);
    },
    read: (scope) => inner.read(scope),
    ...overrides,
  };
  return { store, open: () => open.size, log: () => log, reserved: () => reserved };
}

/**
 * An outermost middleware that reads what the usage middleware stored once its `next()` returned,
 * the way a logger's `enrich` would. One entry per call, in the order the calls finished.
 */
export function costProbe() {
  const fields: Partial<UsageLogFields>[] = [];
  const middleware: VernLLMMiddleware = {
    name: 'probe',
    position: 'outermost',
    wrap: async (_request, next, ctx) => {
      try {
        return await next();
      } finally {
        fields.push(usageLogFields(ctx));
      }
    },
  };
  return { middleware, fields };
}

/** Collects the custom events middleware emit, such as `usage.budget_warning`. */
export function eventProbe() {
  const events: { name: string; data: unknown }[] = [];
  const middleware: VernLLMMiddleware = {
    name: 'events',
    onEvent: (event) => {
      if (event.kind === 'custom') events.push({ name: event.name, data: event.data });
    },
  };
  return { middleware, events };
}

/** An ISO date `daysAgo` days back, so a test never goes stale as the calendar moves on. */
export function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

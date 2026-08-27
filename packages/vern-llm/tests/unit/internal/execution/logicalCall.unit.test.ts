import { describe, expect, it, vi } from 'vitest';

import {
  executeLogicalCall,
  executeLogicalStreamCall,
  runFallbackChain,
  type LogicalCallDependencies,
} from '../../../../src/internal/execution/logicalCall.js';
import { LLMError } from '../../../../src/types/errors.js';
import { FallbackExhaustedError } from '../../../../src/types/fallback.js';
import { createMiddlewareStateBag } from '../../../../src/types/middleware.js';

import type { CallExecutor } from '../../../../src/internal/execution/callExecutor.js';
import type { Logger } from '../../../../src/logger.js';
import type { CallParams, StreamChunk, VernLLMEvent } from '../../../../src/types/index.js';

const fakeLogger: Logger = { debug: () => {}, warn: () => {}, error: () => {} };

/** A real empty `AsyncIterable<StreamChunk>`, since `never[]`/`[]` don't structurally satisfy it (missing `Symbol.asyncIterator`). */
async function* emptyChunks(): AsyncIterable<StreamChunk> {}

/** Wraps a plain array of chunks as a real `AsyncIterable<StreamChunk>`, for tests that need to assert reference equality against the original array-backed value. */
function toAsyncIterable(items: StreamChunk[]): AsyncIterable<StreamChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* items;
    },
  };
}

/**
 * Builds a minimal fake `CallExecutor`: only the members
 * `runFallbackChain`/`executeLogicalCall`/`executeLogicalStreamCall`
 * actually touch (`providerName`, `model`, `assertBreakerClosed`, `run`,
 * `runStream`) are implemented, everything else is intentionally absent
 * so a test fails loudly if the functions under test start relying on
 * something new.
 */
function fakeExecutor(overrides: {
  providerName: string;
  model?: string;
  assertBreakerClosed?: () => void;
  run?: (onAttempt: () => void) => Promise<unknown>;
  runStream?: (
    onAttempt: () => void,
  ) => Promise<{ chunks: AsyncIterable<StreamChunk>; finalResult: Promise<unknown> }>;
}): CallExecutor {
  return {
    providerName: overrides.providerName,
    model: overrides.model ?? 'default-model',
    jsonObjectModeSupported: true,
    assertBreakerClosed: overrides.assertBreakerClosed ?? (() => {}),
    run: async (_params: unknown, _requestId: unknown, onAttempt: () => void) => {
      onAttempt();
      return overrides.run ? overrides.run(onAttempt) : 'default-result';
    },
    runStream: async (_params: unknown, _requestId: unknown, onAttempt: () => void) => {
      onAttempt();
      return overrides.runStream
        ? overrides.runStream(onAttempt)
        : { chunks: emptyChunks(), finalResult: Promise.resolve('') };
    },
  } as unknown as CallExecutor;
}

function dependencies(
  executors: CallExecutor[],
  overrides: Partial<Omit<LogicalCallDependencies, 'executors'>> = {},
): LogicalCallDependencies {
  return {
    executors,
    fallbackOn: overrides.fallbackOn ?? (() => 'next'),
    reportEvent: overrides.reportEvent ?? (() => {}),
    middleware: overrides.middleware ?? [],
    middlewareTimeoutMs: overrides.middlewareTimeoutMs ?? 5000,
    logger: overrides.logger ?? fakeLogger,
  };
}

const state = createMiddlewareStateBag();

describe('runFallbackChain', () => {
  it('returns the primary target result without ever consulting fallbackOn on a lone success', async () => {
    const fallbackOn = vi.fn();
    const primary = fakeExecutor({ providerName: 'primary' });

    const outcome = await runFallbackChain(
      dependencies([primary], { fallbackOn }),
      { model: undefined, signal: undefined },
      'req-1',
      state,
      async (_executor, onAttempt) => {
        onAttempt();
        return 'ok';
      },
    );

    expect(outcome).toEqual({ result: 'ok', executor: primary, index: 0, attemptCount: 1 });
    expect(fallbackOn).not.toHaveBeenCalled();
  });

  it('checks the breaker for every target except the first when skipBreakerCheckForFirst is set', async () => {
    const primaryCheck = vi.fn();
    const fallbackCheck = vi.fn();
    const primary = fakeExecutor({ providerName: 'primary', assertBreakerClosed: primaryCheck });
    const fallback = fakeExecutor({
      providerName: 'fallback',
      assertBreakerClosed: fallbackCheck,
    });

    await runFallbackChain(
      dependencies([primary, fallback]),
      { model: undefined, signal: undefined },
      'req-1',
      state,
      async (executor) => {
        if (executor === primary) throw new LLMError('primary down', 'api', { status: 500 });
        return 'ok';
      },
      true,
    );

    expect(primaryCheck).not.toHaveBeenCalled();
    expect(fallbackCheck).toHaveBeenCalledTimes(1);
  });

  it('checks the breaker for the first target when skipBreakerCheckForFirst is not set', async () => {
    const primaryCheck = vi.fn();
    const primary = fakeExecutor({ providerName: 'primary', assertBreakerClosed: primaryCheck });

    await runFallbackChain(
      dependencies([primary]),
      { model: undefined, signal: undefined },
      'req-1',
      state,
      async () => 'ok',
      false,
    );

    expect(primaryCheck).toHaveBeenCalledTimes(1);
  });

  it('falls over to the next target when fallbackOn says next, reporting a fallback event', async () => {
    const events: VernLLMEvent[] = [];
    const primary = fakeExecutor({ providerName: 'primary' });
    const secondary = fakeExecutor({ providerName: 'secondary' });

    let calls = 0;
    const attempt = async (executor: CallExecutor, onAttempt: () => void) => {
      calls++;
      onAttempt();
      if (executor.providerName === 'primary') {
        throw new LLMError('primary down', 'api', { status: 500 });
      }
      return 'from-secondary';
    };

    const outcome = await runFallbackChain(
      dependencies([primary, secondary], {
        fallbackOn: () => 'next',
        reportEvent: (event) => events.push(event),
      }),
      { model: undefined, signal: undefined },
      'req-1',
      state,
      attempt,
    );

    expect(outcome.result).toBe('from-secondary');
    expect(outcome.executor).toBe(secondary);
    expect(outcome.index).toBe(1);
    expect(calls).toBe(2);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'fallback',
      from: 'primary',
      to: 'secondary',
      fromIndex: -1,
      toIndex: 0,
    });
  });

  it('throws the lone normalized error directly when only one target was ever tried', async () => {
    const primary = fakeExecutor({ providerName: 'primary' });

    await expect(
      runFallbackChain(
        dependencies([primary]),
        { model: undefined, signal: undefined },
        'req-1',
        state,
        async () => {
          throw new LLMError('down', 'api', { status: 500 });
        },
      ),
    ).rejects.toMatchObject({ type: 'api', message: 'down' });
  });

  it('throws a FallbackExhaustedError carrying every attempt once more than one target has failed', async () => {
    const primary = fakeExecutor({ providerName: 'primary' });
    const secondary = fakeExecutor({ providerName: 'secondary' });

    try {
      await runFallbackChain(
        dependencies([primary, secondary], { fallbackOn: () => 'next' }),
        { model: undefined, signal: undefined },
        'req-1',
        state,
        async () => {
          throw new LLMError('down', 'api', { status: 500 });
        },
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FallbackExhaustedError);
      const fallbackError = error as FallbackExhaustedError;
      expect(fallbackError.attempts).toHaveLength(2);
      expect(fallbackError.attempts.map((a) => a.provider)).toEqual(['primary', 'secondary']);
    }
  });

  it('always consults fallbackOn on the last target too, even though the chain stops regardless of its answer', async () => {
    const fallbackOn = vi.fn().mockReturnValue('next');
    const primary = fakeExecutor({ providerName: 'primary' });

    await expect(
      runFallbackChain(
        dependencies([primary], { fallbackOn }),
        { model: undefined, signal: undefined },
        'req-1',
        state,
        async () => {
          throw new LLMError('down', 'api', { status: 500 });
        },
      ),
    ).rejects.toThrow();

    expect(fallbackOn).toHaveBeenCalledTimes(1);
    expect(fallbackOn).toHaveBeenCalledWith(expect.any(LLMError), { isLastTarget: true });
  });

  it('stops the chain early when fallbackOn returns stop, even with more targets remaining', async () => {
    const secondaryAttempt = vi.fn();
    const primary = fakeExecutor({ providerName: 'primary' });
    const secondary = fakeExecutor({ providerName: 'secondary' });

    await expect(
      runFallbackChain(
        dependencies([primary, secondary], { fallbackOn: () => 'stop' }),
        { model: undefined, signal: undefined },
        'req-1',
        state,
        async (executor) => {
          if (executor.providerName === 'secondary') secondaryAttempt();
          throw new LLMError('down', 'api', { status: 500 });
        },
      ),
    ).rejects.toMatchObject({ type: 'api' });

    expect(secondaryAttempt).not.toHaveBeenCalled();
  });
});

describe('executeLogicalCall', () => {
  it("returns a CallResult with the winning target's meta and writes it onto params.meta", async () => {
    const primary = fakeExecutor({
      providerName: 'primary',
      model: 'model-a',
      run: async () => 'the answer',
    });

    const params: CallParams<string> & { meta?: { current?: unknown } } = {
      userContent: 'hi',
      jsonMode: false,
      meta: {},
    };

    const outcome = await executeLogicalCall(dependencies([primary]), params, 'req-1', true, state);

    expect(outcome.value).toBe('the answer');
    expect(outcome.meta).toEqual({
      provider: 'primary',
      model: 'model-a',
      fallbackIndex: -1,
      usedFallback: false,
      attempts: 1,
    });
    expect(params.meta?.current).toEqual(outcome.meta);
  });

  it('reports usedFallback and the right fallbackIndex when the fallback target answers', async () => {
    const primary = fakeExecutor({
      providerName: 'primary',
      run: async () => {
        throw new LLMError('down', 'api', { status: 500 });
      },
    });
    const fallback = fakeExecutor({ providerName: 'fallback', run: async () => 'from-fallback' });

    const outcome = await executeLogicalCall(
      dependencies([primary, fallback], { fallbackOn: () => 'next' }),
      { userContent: 'hi', jsonMode: false },
      'req-1',
      false,
      state,
    );

    expect(outcome.value).toBe('from-fallback');
    expect(outcome.meta).toMatchObject({
      provider: 'fallback',
      usedFallback: true,
      fallbackIndex: 0,
    });
  });

  it('does not touch params.meta when the caller never set it', async () => {
    const primary = fakeExecutor({ providerName: 'primary', run: async () => 'ok' });
    const params: CallParams<string> = { userContent: 'hi', jsonMode: false };

    await executeLogicalCall(dependencies([primary]), params, 'req-1', true, state);

    expect(params.meta).toBeUndefined();
  });
});

describe('executeLogicalStreamCall', () => {
  it('returns the stream shape as CallResult.value, with meta populated up front (unlike the public params.meta contract)', async () => {
    const chunks = toAsyncIterable([]);
    const finalResult = Promise.resolve('streamed answer');

    const primary = fakeExecutor({
      providerName: 'primary',
      model: 'model-a',
      runStream: async () => ({ chunks, finalResult }),
    });

    const outcome = await executeLogicalStreamCall(
      dependencies([primary]),
      { userContent: 'hi', jsonMode: false, stream: true },
      'req-1',
      true,
      state,
    );

    expect(outcome.value.chunks).toBe(chunks);
    expect(await outcome.value.finalResult).toBe('streamed answer');
    expect(outcome.meta).toEqual({
      provider: 'primary',
      model: 'model-a',
      fallbackIndex: -1,
      usedFallback: false,
      attempts: 1,
    });
  });

  it('writes meta onto params.meta too, as a side channel for cachedCall to read back out', async () => {
    const primary = fakeExecutor({
      providerName: 'primary',
      runStream: async () => ({ chunks: emptyChunks(), finalResult: Promise.resolve('ok') }),
    });

    const params: CallParams<string> & { meta?: { current?: unknown } } = {
      userContent: 'hi',
      jsonMode: false,
      stream: true,
      meta: {},
    };

    const outcome = await executeLogicalStreamCall(
      dependencies([primary]),
      params,
      'req-1',
      true,
      state,
    );

    expect(params.meta?.current).toEqual(outcome.meta);
  });
});

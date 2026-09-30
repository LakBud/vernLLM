import { describe, expect, it, vi } from 'vitest';

import {
  executeLogicalCall,
  executeLogicalStreamCall,
  modelForTarget,
  paramsForTarget,
  runFallbackChain,
  type LogicalCallDependencies,
} from '../../../../src/internal/execution/logicalCall.js';
import { declaredTargets } from '../../../../src/internal/execution/targetOrder.js';
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
 * actually touch (`providerName`, `model`, `assertBreakerClosed`,
 * `releaseBreakerTrial`, `run`, `runStream`) are implemented, everything else is intentionally absent
 * so a test fails loudly if the functions under test start relying on
 * something new.
 */
function fakeExecutor(overrides: {
  providerName: string;
  model?: string;
  assertBreakerClosed?: () => void;
  releaseBreakerTrial?: () => void;
  run?: (onAttempt: () => void) => Promise<unknown>;
  runStream?: (
    onAttempt: () => void,
    onOpen: () => void,
  ) => Promise<{ chunks: AsyncIterable<StreamChunk>; finalResult: Promise<unknown> }>;
}): CallExecutor {
  return {
    providerName: overrides.providerName,
    model: overrides.model ?? 'default-model',
    adapter: { name: 'fake' },
    jsonObjectModeSupported: true,
    assertBreakerClosed: overrides.assertBreakerClosed ?? (() => {}),
    releaseBreakerTrial: overrides.releaseBreakerTrial ?? (() => {}),
    run: async (_params: unknown, _requestId: unknown, onAttempt: () => void) => {
      onAttempt();
      return overrides.run ? overrides.run(onAttempt) : 'default-result';
    },
    runStream: async (
      _params: unknown,
      _requestId: unknown,
      onAttempt: () => void,
      _state: unknown,
      onOpen: () => void,
    ) => {
      onAttempt();
      return overrides.runStream
        ? overrides.runStream(onAttempt, onOpen)
        : { chunks: emptyChunks(), finalResult: Promise.resolve('') };
    },
  } as unknown as CallExecutor;
}

function dependencies(
  executors: CallExecutor[],
  overrides: Partial<Omit<LogicalCallDependencies, 'targets'>> = {},
): LogicalCallDependencies {
  return {
    targets: declaredTargets(executors),
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

    expect(outcome).toEqual({
      result: 'ok',
      executor: primary,
      index: 0,
      position: 0,
      attemptCount: 1,
      model: 'default-model',
    });
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
    expect(fallbackOn).toHaveBeenCalledWith(expect.any(LLMError), {
      isLastTarget: true,
      failed: { name: 'primary', index: 0, model: 'default-model', adapter: { name: 'fake' } },
    });
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

describe('runFallbackChain trial release', () => {
  it("releases the failing target's half-open trial, so a non counted failure cannot wedge it", async () => {
    const release = vi.fn();
    const primary = fakeExecutor({
      providerName: 'primary',
      releaseBreakerTrial: release,
      run: async () => {
        throw new LLMError('bad output', 'validation');
      },
    });

    await expect(
      runFallbackChain(
        dependencies([primary]),
        {},
        'req-1',
        createMiddlewareStateBag(),
        (executor, onAttempt) => executor.run({} as never, 'req-1', onAttempt),
      ),
    ).rejects.toBeInstanceOf(LLMError);

    expect(release).toHaveBeenCalledTimes(1);
  });

  it('does not release a target that succeeded', async () => {
    const release = vi.fn();
    const primary = fakeExecutor({ providerName: 'primary', releaseBreakerTrial: release });

    await runFallbackChain(
      dependencies([primary]),
      {},
      'req-1',
      createMiddlewareStateBag(),
      (executor, onAttempt) => executor.run({} as never, 'req-1', onAttempt),
    );

    expect(release).not.toHaveBeenCalled();
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
      position: 0,
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
      position: 0,
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

describe('runFallbackChain, per call model override', () => {
  it('checks and releases the primary breaker with the override and each fallback with its own model', async () => {
    const primaryCheck = vi.fn();
    const primaryRelease = vi.fn();
    const fallbackCheck = vi.fn();
    const primary = fakeExecutor({
      providerName: 'primary',
      model: 'primary-model',
      assertBreakerClosed: primaryCheck,
      releaseBreakerTrial: primaryRelease,
    });
    const fallback = fakeExecutor({
      providerName: 'fallback',
      model: 'fallback-model',
      assertBreakerClosed: fallbackCheck,
    });

    const outcome = await runFallbackChain(
      dependencies([primary, fallback]),
      { model: 'override-model', signal: undefined },
      'req-1',
      state,
      async (executor) => {
        if (executor === primary) throw new LLMError('down', 'api', { status: 503 });
        return 'ok';
      },
    );

    expect(primaryCheck.mock.calls[0]?.[0]).toBe('override-model');
    expect(primaryRelease.mock.calls[0]?.[0]).toBe('override-model');
    expect(fallbackCheck.mock.calls[0]?.[0]).toBeUndefined();
    expect(outcome.model).toBe('fallback-model');
  });

  it('passes the target index to attempt so callers can pick per target params', async () => {
    const seen: number[] = [];
    const primary = fakeExecutor({ providerName: 'primary' });
    const fallback = fakeExecutor({ providerName: 'fallback' });

    await runFallbackChain(
      dependencies([primary, fallback]),
      { model: undefined, signal: undefined },
      'req-1',
      state,
      async (_executor, _onAttempt, targetIndex) => {
        seen.push(targetIndex);
        if (targetIndex === 0) throw new LLMError('down', 'api', { status: 503 });
        return 'ok';
      },
    );

    expect(seen).toEqual([0, 1]);
  });
});

describe('modelForTarget and paramsForTarget', () => {
  it('keep the override for the primary only', () => {
    expect(modelForTarget({ model: 'm' }, 0)).toBe('m');
    expect(modelForTarget({ model: 'm' }, 1)).toBeUndefined();
    expect(modelForTarget({ model: undefined }, 0)).toBeUndefined();
  });

  it('returns the same params object when nothing needs to change', () => {
    const withOverride = { model: 'm', userContent: 'u' };
    const withoutOverride = { model: undefined, userContent: 'u' };

    expect(paramsForTarget(withOverride, 0)).toBe(withOverride);
    expect(paramsForTarget(withoutOverride, 2)).toBe(withoutOverride);
  });

  it('drops the override for a fallback without touching the caller params', () => {
    const signal = new AbortController().signal;
    const params = { model: 'm', userContent: 'u', signal };

    const forFallback = paramsForTarget(params, 1);

    expect(forFallback).toEqual({ model: undefined, userContent: 'u', signal });
    expect(params.model).toBe('m');
  });
});

describe('reordered targets', () => {
  const failing = () => {
    throw new LLMError('down', 'api', { status: 500 });
  };

  /** `dependencies` for a chain narrowed to `names`, in that order. Each target keeps its declared index. */
  function inOrder(
    all: CallExecutor[],
    names: string[],
    overrides: Partial<Omit<LogicalCallDependencies, 'targets'>> = {},
  ): LogicalCallDependencies {
    const declared = declaredTargets(all);

    return {
      ...dependencies(all, overrides),
      targets: names.map((name) => declared.find((t) => t.executor.providerName === name)!),
    };
  }

  /** Three targets named `a`, `b`, `c`. Overrides never rename them, since the names are what the tests select by. */
  const chainOf = (
    overrides: Partial<Omit<Parameters<typeof fakeExecutor>[0], 'providerName'>>[] = [],
  ) => [
    fakeExecutor({ providerName: 'a', model: 'a-model', ...overrides[0] }),
    fakeExecutor({ providerName: 'b', model: 'b-model', ...overrides[1] }),
    fakeExecutor({ providerName: 'c', model: 'c-model', ...overrides[2] }),
  ];

  it('tries the given targets in the given order, passing each its declared index and its position', async () => {
    const all = chainOf();
    const seen: Array<[string, number, number]> = [];

    await runFallbackChain(
      inOrder(all, ['c', 'a']),
      { model: undefined, signal: undefined },
      'req-1',
      state,
      async (executor, _onAttempt, targetIndex, position) => {
        seen.push([executor.providerName, targetIndex, position]);
        if (position === 0) throw new LLMError('down', 'api', { status: 500 });
        return 'ok';
      },
    );

    expect(seen).toEqual([
      ['c', 2, 0],
      ['a', 0, 1],
    ]);
  });

  it('never tries a target the order leaves out', async () => {
    const all = chainOf();
    const attempted: string[] = [];

    await expect(
      runFallbackChain(
        inOrder(all, ['c', 'a']),
        { model: undefined, signal: undefined },
        'req-1',
        state,
        async (executor) => {
          attempted.push(executor.providerName);
          throw new LLMError('down', 'api', { status: 500 });
        },
      ),
    ).rejects.toBeInstanceOf(FallbackExhaustedError);

    expect(attempted).toEqual(['c', 'a']);
  });

  it('reports the winner with its declared index and its position in the order', async () => {
    const all = chainOf();

    const outcome = await runFallbackChain(
      inOrder(all, ['c', 'b']),
      { model: undefined, signal: undefined },
      'req-1',
      state,
      async (executor) => {
        if (executor.providerName === 'c') return failing();
        return 'ok';
      },
    );

    expect(outcome).toMatchObject({ index: 1, position: 1, model: 'b-model' });
    expect(outcome.executor).toBe(all[1]);
  });

  it('keeps declared indices in the fallback event and in every attempt', async () => {
    const all = chainOf();
    const events: VernLLMEvent[] = [];

    const error = await runFallbackChain(
      inOrder(all, ['c', 'a'], { reportEvent: (event) => events.push(event) }),
      { model: undefined, signal: undefined },
      'req-1',
      state,
      async () => failing(),
    ).catch((e: unknown) => e);

    // `c` is the second fallback (index 1), `a` the primary (index -1).
    expect(events).toEqual([
      expect.objectContaining({ kind: 'fallback', from: 'c', to: 'a', fromIndex: 1, toIndex: -1 }),
    ]);
    expect((error as FallbackExhaustedError).attempts).toMatchObject([
      { provider: 'c', model: 'c-model', index: 1 },
      { provider: 'a', model: 'a-model', index: -1 },
    ]);
  });

  it('describes a failed fallback target as a fallback attempt in the fallback event context', async () => {
    const all = chainOf();
    const contexts: Array<{ isFallbackAttempt?: boolean; requestedProvider?: string }> = [];

    await runFallbackChain(
      inOrder(all, ['c', 'a'], {
        middleware: [{ name: 'observer', onEvent: (_event, ctx) => contexts.push(ctx as never) }],
      }),
      { model: undefined, signal: undefined },
      'req-1',
      state,
      async (executor) => {
        if (executor.providerName === 'c') return failing();
        return 'ok';
      },
    );

    expect(contexts[0]).toMatchObject({ requestedProvider: 'c', isFallbackAttempt: true });
  });

  it('decides isLastTarget by position, so the last declared target is not last when it goes first', async () => {
    const all = chainOf();
    const fallbackOn = vi.fn().mockReturnValue('next');

    await expect(
      runFallbackChain(
        inOrder(all, ['c', 'b'], { fallbackOn }),
        { model: undefined, signal: undefined },
        'req-1',
        state,
        async () => failing(),
      ),
    ).rejects.toBeInstanceOf(FallbackExhaustedError);

    expect(fallbackOn.mock.calls.map(([, context]) => context.isLastTarget)).toEqual([false, true]);
  });

  it('skips the breaker check for the first target in the order, whichever target that is', async () => {
    const checks: string[] = [];
    const all = chainOf(
      ['a', 'b', 'c'].map((name) => ({
        assertBreakerClosed: () => {
          checks.push(name);
        },
      })),
    );

    await runFallbackChain(
      inOrder(all, ['c', 'a']),
      { model: undefined, signal: undefined },
      'req-1',
      state,
      async (executor) => {
        if (executor.providerName === 'c') return failing();
        return 'ok';
      },
      true,
    );

    expect(checks).toEqual(['a']);
  });

  it('keeps the per call model on the declared primary, wherever it sits in the order', async () => {
    const checked: Array<[string, string | undefined]> = [];
    const all = chainOf(
      ['a', 'b', 'c'].map((name) => ({
        assertBreakerClosed: ((model?: string) => {
          checked.push([name, model]);
        }) as never,
      })),
    );

    const outcome = await runFallbackChain(
      inOrder(all, ['b', 'a']),
      { model: 'override-model', signal: undefined },
      'req-1',
      state,
      async (executor) => {
        if (executor.providerName === 'b') return failing();
        return 'ok';
      },
    );

    expect(checked).toEqual([
      ['b', undefined],
      ['a', 'override-model'],
    ]);
    expect(outcome.model).toBe('override-model');
  });

  it('puts the declared fallbackIndex, usedFallback and the position in the meta of a reordered call', async () => {
    const all = chainOf([
      { run: async () => 'from a' },
      { run: async () => failing() },
      { run: async () => failing() },
    ]);

    const outcome = await executeLogicalCall(
      inOrder(all, ['c', 'b', 'a']),
      { userContent: 'hi', jsonMode: false },
      'req-1',
      false,
      state,
    );

    expect(outcome.meta).toEqual({
      provider: 'a',
      model: 'a-model',
      fallbackIndex: -1,
      usedFallback: false,
      attempts: 1,
      position: 2,
    });
  });

  it('opens a stream with the position of the target that opened it, updating it if the chain moves on', async () => {
    const all = chainOf([
      { runStream: async (_onAttempt, onOpen) => (onOpen(), streamOf('from a')) },
      {
        runStream: async (_onAttempt, onOpen) => {
          onOpen();
          return failing();
        },
      },
      {},
    ]);

    const outcome = await executeLogicalStreamCall(
      inOrder(all, ['b', 'a']),
      { userContent: 'hi', jsonMode: false, stream: true },
      'req-1',
      false,
      state,
    );

    // `b` opened first, so it is what the caller sees up front.
    expect(outcome.meta).toMatchObject({ provider: 'b', fallbackIndex: 0, position: 0 });

    // The chain then moved on to `a`, and the same meta object follows it.
    await expect(outcome.value.finalResult).resolves.toBe('from a');
    expect(outcome.meta).toMatchObject({
      provider: 'a',
      fallbackIndex: -1,
      usedFallback: false,
      position: 1,
    });
  });
});

/** A stream that has already finished, answering `text`. */
function streamOf(text: string) {
  return { chunks: emptyChunks(), finalResult: Promise.resolve(text) };
}

describe('fallbackOn target details', () => {
  const infoOf = (name: string, index: number, model: string) => ({
    name,
    index,
    model,
    adapter: { name: 'fake' },
  });

  const chain = () => [
    fakeExecutor({ providerName: 'a', model: 'a-model' }),
    fakeExecutor({ providerName: 'b', model: 'b-model' }),
    fakeExecutor({ providerName: 'c', model: 'c-model' }),
  ];

  const failing = async () => {
    throw new LLMError('down', 'api', { status: 500 });
  };

  it('passes the failed and the next target on every hop, and none for next on the last', async () => {
    const all = chain();
    const fallbackOn = vi.fn().mockReturnValue('next');

    await expect(
      runFallbackChain(
        dependencies(all, { fallbackOn }),
        { model: undefined, signal: undefined },
        'req-1',
        state,
        failing,
      ),
    ).rejects.toBeInstanceOf(FallbackExhaustedError);

    const contexts = fallbackOn.mock.calls.map(([, context]) => context);
    expect(contexts).toEqual([
      { isLastTarget: false, failed: infoOf('a', 0, 'a-model'), next: infoOf('b', 1, 'b-model') },
      { isLastTarget: false, failed: infoOf('b', 1, 'b-model'), next: infoOf('c', 2, 'c-model') },
      { isLastTarget: true, failed: infoOf('c', 2, 'c-model') },
    ]);
    expect(contexts[2]).not.toHaveProperty('next');
  });

  it('follows the order tried, keeping declared indices', async () => {
    const all = chain();
    const fallbackOn = vi.fn().mockReturnValue('next');
    const declared = declaredTargets(all);

    await expect(
      runFallbackChain(
        { ...dependencies(all, { fallbackOn }), targets: [declared[2]!, declared[0]!] },
        { model: undefined, signal: undefined },
        'req-1',
        state,
        failing,
      ),
    ).rejects.toBeInstanceOf(FallbackExhaustedError);

    expect(fallbackOn.mock.calls.map(([, context]) => context)).toEqual([
      { isLastTarget: false, failed: infoOf('c', 2, 'c-model'), next: infoOf('a', 0, 'a-model') },
      { isLastTarget: true, failed: infoOf('a', 0, 'a-model') },
    ]);
  });

  it('names the per call model on the failed primary, and each fallback by its own', async () => {
    const all = chain();
    const fallbackOn = vi.fn().mockReturnValue('next');

    await expect(
      runFallbackChain(
        dependencies(all, { fallbackOn }),
        { model: 'override-model', signal: undefined },
        'req-1',
        state,
        failing,
      ),
    ).rejects.toBeInstanceOf(FallbackExhaustedError);

    const [first, second] = fallbackOn.mock.calls.map(([, context]) => context);
    expect(first.failed.model).toBe('override-model');
    expect(first.next.model).toBe('b-model');
    expect(second.failed.model).toBe('b-model');
  });

  it('lets a policy that ignores the details behave as before', async () => {
    const all = chain();

    const outcome = await runFallbackChain(
      dependencies(all, {
        fallbackOn: (_error, { isLastTarget }) => (isLastTarget ? 'stop' : 'next'),
      }),
      { model: undefined, signal: undefined },
      'req-1',
      state,
      async (executor) => {
        if (executor.providerName !== 'c') return failing();
        return 'ok';
      },
    );

    expect(outcome.executor).toBe(all[2]);
  });
});

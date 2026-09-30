import { describe, expect, it, vi } from 'vitest';

import {
  runOperation,
  type RunOperationDependencies,
} from '../../../../../src/internal/execution/runOperation.js';
import { buildMiddlewarePipeline } from '../../../../../src/internal/resolveMiddlewareOrder.js';
import { LLMError } from '../../../../../src/types/errors.js';
import { createMiddlewareStateBag } from '../../../../../src/types/middleware.js';

import type { CallExecutor } from '../../../../../src/internal/execution/callExecutor.js';
import type { ResolvedTarget } from '../../../../../src/internal/execution/targetOrder.js';
import type { Logger } from '../../../../../src/logger.js';
import type {
  CallParams,
  CallResult,
  TargetInfo,
  VernLLMEvent,
  VernLLMMiddleware,
} from '../../../../../src/types/index.js';

/**
 * Only `providerName`, `model`, and `previewRequest` are ever touched by
 * `runOperation`; everything else is intentionally absent so a test
 * fails loudly if `runOperation` starts relying on something new.
 */
function fakePrimaryExecutor(): CallExecutor {
  return {
    providerName: 'primary',
    model: 'default-model',
    adapter: { name: 'fake' },
    jsonObjectModeSupported: true,
    previewRequest: () => ({
      model: 'default-model',
      request: { model: 'default-model', max_tokens: 100, messages: [] },
    }),
  } as unknown as CallExecutor;
}

function fakeLogger(): Logger {
  return { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const primary = fakePrimaryExecutor();
const declared: ResolvedTarget[] = [{ executor: primary, index: 0 }];

function dependencies(
  overrides: Partial<Omit<RunOperationDependencies, 'pipeline'>> & {
    middleware?: VernLLMMiddleware[];
  } = {},
): RunOperationDependencies {
  return {
    pipeline: buildMiddlewarePipeline(overrides.middleware ?? []),
    primaryExecutor: overrides.primaryExecutor ?? primary,
    targets: overrides.targets ?? declared,
    middlewareTimeoutMs: overrides.middlewareTimeoutMs ?? 5000,
    logger: overrides.logger ?? fakeLogger(),
    reportEvent: overrides.reportEvent ?? (() => {}),
  };
}

const params: CallParams<unknown> = { userContent: 'hi', jsonMode: false };
const requestId = 'req-1';

describe('runOperation', () => {
  it('calls coreOperation directly, without building any middleware context, when there is no middleware configured', async () => {
    const coreOperation = vi.fn(async () => ({ value: 'result' }) satisfies CallResult);

    const outcome = await runOperation(
      dependencies({ middleware: [] }),
      params,
      requestId,
      createMiddlewareStateBag(),
      declared,
      coreOperation,
    );

    expect(outcome).toEqual({ value: 'result' });
    expect(coreOperation).toHaveBeenCalledTimes(1);
  });

  it('calls coreOperation directly when this invocation is already wrapped by cachedCall, so wrap never fires twice', async () => {
    const wrap = vi.fn(async (_request, next: () => Promise<CallResult>) => next());
    const middleware: VernLLMMiddleware = { name: 'mw', wrap };
    const coreOperation = vi.fn(async () => ({ value: 'result' }) satisfies CallResult);

    const outcome = await runOperation(
      dependencies({ middleware: [middleware] }),
      params,
      requestId,
      createMiddlewareStateBag(),
      declared,
      coreOperation,
      true,
    );

    expect(outcome).toEqual({ value: 'result' });
    expect(wrap).not.toHaveBeenCalled();
    expect(coreOperation).toHaveBeenCalledTimes(1);
  });

  it("runs a single wrap around coreOperation, passing it the primary target's previewed request", async () => {
    const seenRequests: unknown[] = [];

    const middleware: VernLLMMiddleware = {
      name: 'mw',
      wrap: async (request, next) => {
        seenRequests.push(request);
        return next();
      },
    };

    const coreOperation = vi.fn(async () => ({ value: 'result' }) satisfies CallResult);

    await runOperation(
      dependencies({ middleware: [middleware] }),
      params,
      requestId,
      createMiddlewareStateBag(),
      declared,
      coreOperation,
    );

    expect(seenRequests).toEqual([{ model: 'default-model', max_tokens: 100, messages: [] }]);
    expect(coreOperation).toHaveBeenCalledTimes(1);
  });

  it('skips a middleware whose transform-only entry has no wrap, falling straight through to the next one', async () => {
    const order: string[] = [];

    const transformOnly: VernLLMMiddleware = { name: 'transform-only' };
    const wrapper: VernLLMMiddleware = {
      name: 'wrapper',
      priority: 1,
      wrap: async (_request, next) => {
        order.push('wrapper');
        return next();
      },
    };

    await runOperation(
      dependencies({ middleware: [transformOnly, wrapper] }),
      params,
      requestId,
      createMiddlewareStateBag(),
      declared,
      async () => {
        order.push('core');
        return { value: 'ok' };
      },
    );

    expect(order).toEqual(['wrapper', 'core']);
  });

  it('composes middleware as nested calls: lower priority is outermost, first to start, last to finish', async () => {
    const order: string[] = [];

    const outer: VernLLMMiddleware = {
      name: 'outer',
      priority: 0,
      wrap: async (_request, next) => {
        order.push('outer:pre');
        const result = await next();
        order.push('outer:post');
        return result;
      },
    };

    const inner: VernLLMMiddleware = {
      name: 'inner',
      priority: 1,
      wrap: async (_request, next) => {
        order.push('inner:pre');
        const result = await next();
        order.push('inner:post');
        return result;
      },
    };

    await runOperation(
      dependencies({ middleware: [outer, inner] }),
      params,
      requestId,
      createMiddlewareStateBag(),
      declared,
      async () => {
        order.push('core');
        return { value: 'ok' };
      },
    );

    expect(order).toEqual(['outer:pre', 'inner:pre', 'core', 'inner:post', 'outer:post']);
  });

  it('a wrap that never calls next() short-circuits coreOperation entirely, and reports wrap_short_circuit', async () => {
    const events: VernLLMEvent[] = [];
    const coreOperation = vi.fn(async () => ({ value: 'never' }) satisfies CallResult);

    const middleware: VernLLMMiddleware = {
      name: 'short-circuit',
      wrap: async () => ({ value: 'canned' }),
    };

    const outcome = await runOperation(
      dependencies({ middleware: [middleware], reportEvent: (event) => events.push(event) }),
      params,
      requestId,
      createMiddlewareStateBag(),
      declared,
      coreOperation,
    );

    expect(outcome).toEqual({ value: 'canned' });
    expect(coreOperation).not.toHaveBeenCalled();
    expect(events).toEqual([
      { kind: 'middleware', requestId, middleware: 'short-circuit', hook: 'wrap_short_circuit' },
    ]);
  });

  it("labels an unnamed middleware by its transformOrder index, not wrapOrder's, when position reorders wrap nesting", async () => {
    const events: VernLLMEvent[] = [];
    const coreOperation = vi.fn(async () => ({ value: 'never' }) satisfies CallResult);

    // transformOrder: [named (index 0), unnamed (index 1)] since priority ties
    // break by original array order. `position: 'outermost'` on the unnamed
    // entry moves it to the front of wrapOrder, so wrapOrder's own loop index
    // for it is 0, not its transformOrder index of 1. Its label must still
    // read "[1]" to match `ctx.registeredMiddlewareNames`.
    const named: VernLLMMiddleware = { name: 'named', wrap: async (_r, next) => next() };
    const unnamed: VernLLMMiddleware = {
      position: 'outermost',
      wrap: async () => ({ value: 'canned' }),
    };

    const outcome = await runOperation(
      dependencies({ middleware: [named, unnamed], reportEvent: (event) => events.push(event) }),
      params,
      requestId,
      createMiddlewareStateBag(),
      declared,
      coreOperation,
    );

    expect(outcome).toEqual({ value: 'canned' });
    expect(events).toEqual([
      { kind: 'middleware', requestId, middleware: '[1]', hook: 'wrap_short_circuit' },
    ]);
  });

  it('calling next() more than once dispatches coreOperation only once, reusing the first call for every subsequent one', async () => {
    const coreOperation = vi.fn(async () => ({ value: 'result' }) satisfies CallResult);

    const middleware: VernLLMMiddleware = {
      name: 'double-caller',
      wrap: async (_request, next) => {
        const first = await next();
        const second = await next();
        expect(second).toBe(first); // same CallResult object, not a second dispatch's result
        return second;
      },
    };

    const outcome = await runOperation(
      dependencies({ middleware: [middleware] }),
      params,
      requestId,
      createMiddlewareStateBag(),
      declared,
      coreOperation,
    );

    expect(outcome).toEqual({ value: 'result' });
    expect(coreOperation).toHaveBeenCalledTimes(1);
  });

  it('calling next() concurrently (no await between calls) still dispatches coreOperation only once', async () => {
    const coreOperation = vi.fn(async () => ({ value: 'result' }) satisfies CallResult);

    const middleware: VernLLMMiddleware = {
      name: 'concurrent-caller',
      wrap: async (_request, next) => {
        // Both calls happen synchronously, before either has a chance to
        // resolve. This is the case an `async`-only guard (checking a
        // boolean after an `await`) would miss.
        const [first, second] = await Promise.all([next(), next()]);
        expect(second).toBe(first);
        return first;
      },
    };

    const outcome = await runOperation(
      dependencies({ middleware: [middleware] }),
      params,
      requestId,
      createMiddlewareStateBag(),
      declared,
      coreOperation,
    );

    expect(outcome).toEqual({ value: 'result' });
    expect(coreOperation).toHaveBeenCalledTimes(1);
  });

  it('enabled: false skips the middleware and reports enabled_skip', async () => {
    const events: VernLLMEvent[] = [];
    const wrap = vi.fn(async (_request, next: () => Promise<CallResult>) => next());

    const middleware: VernLLMMiddleware = { name: 'disabled', enabled: false, wrap };

    const outcome = await runOperation(
      dependencies({ middleware: [middleware], reportEvent: (event) => events.push(event) }),
      params,
      requestId,
      createMiddlewareStateBag(),
      declared,
      async () => ({ value: 'ok' }),
    );

    expect(outcome).toEqual({ value: 'ok' });
    expect(wrap).not.toHaveBeenCalled();
    expect(events).toEqual([
      { kind: 'middleware', requestId, middleware: 'disabled', hook: 'enabled_skip' },
    ]);
  });

  it('does not report enabled_skip when `enabled` reads as undefined by the time it is re-checked, even though resolveEnabled saw it defined', async () => {
    // `enabled` is read once inside resolveEnabled to decide whether the
    // middleware runs, and again afterward to decide whether to report
    // enabled_skip. A getter that changes what it returns between those
    // two reads exercises the branch where the second read no longer
    // sees a defined `enabled`.
    const events: VernLLMEvent[] = [];
    const wrap = vi.fn(async (_request, next: () => Promise<CallResult>) => next());
    let reads = 0;
    const middleware: VernLLMMiddleware = {
      name: 'shifting-enabled',
      wrap,
      get enabled() {
        reads += 1;
        return reads === 1 ? false : undefined;
      },
    };

    const outcome = await runOperation(
      dependencies({ middleware: [middleware], reportEvent: (event) => events.push(event) }),
      params,
      requestId,
      createMiddlewareStateBag(),
      declared,
      async () => ({ value: 'ok' }),
    );

    expect(outcome).toEqual({ value: 'ok' });
    expect(wrap).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('does not report enabled_skip when enabled was never set at all (only when it was explicitly configured)', async () => {
    const events: VernLLMEvent[] = [];
    const middleware: VernLLMMiddleware = {
      name: 'no-enabled-field',
      wrap: async (_request, next) => next(),
    };

    await runOperation(
      dependencies({ middleware: [middleware], reportEvent: (event) => events.push(event) }),
      params,
      requestId,
      createMiddlewareStateBag(),
      declared,
      async () => ({ value: 'ok' }),
    );

    expect(events).toEqual([]);
  });

  it('a throwing enabled predicate is treated as disabled rather than failing the whole call', async () => {
    const logger = fakeLogger();
    const wrap = vi.fn(async (_request, next: () => Promise<CallResult>) => next());

    const middleware: VernLLMMiddleware = {
      name: 'flaky-enabled',
      enabled: () => {
        throw new Error('boom');
      },
      wrap,
    };

    const outcome = await runOperation(
      dependencies({ middleware: [middleware], logger }),
      params,
      requestId,
      createMiddlewareStateBag(),
      declared,
      async () => ({ value: 'ok' }),
    );

    expect(outcome).toEqual({ value: 'ok' });
    expect(wrap).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('a never-resolving enabled predicate is skipped once its middlewareTimeoutMs elapses, logging exactly once', async () => {
    const logger = fakeLogger();
    const wrap = vi.fn(async (_request, next: () => Promise<CallResult>) => next());

    const middleware: VernLLMMiddleware = {
      name: 'hung-enabled',
      enabled: () => new Promise(() => {}),
      wrap,
    };

    const outcome = await runOperation(
      dependencies({ middleware: [middleware], logger, middlewareTimeoutMs: 15 }),
      params,
      requestId,
      createMiddlewareStateBag(),
      declared,
      async () => ({ value: 'ok' }),
    );

    expect(outcome).toEqual({ value: 'ok' });
    expect(wrap).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('a wrap throwing before next() resolves is reclassified through reclassifyMiddlewareThrow', async () => {
    const middleware: VernLLMMiddleware = {
      name: 'buggy',
      wrap: async () => {
        throw new Error('a plain bug');
      },
    };

    await expect(
      runOperation(
        dependencies({ middleware: [middleware] }),
        params,
        requestId,
        createMiddlewareStateBag(),
        declared,
        async () => ({ value: 'never' }),
      ),
    ).rejects.toMatchObject({ type: 'invalid_params', code: 'middleware_threw' });
  });

  it('an already-built LLMError thrown before next() resolves passes through with its own classification intact', async () => {
    const middleware: VernLLMMiddleware = {
      name: 'rate-limiter',
      wrap: async () => {
        throw new LLMError('slow down', 'rate_limited');
      },
    };

    await expect(
      runOperation(
        dependencies({ middleware: [middleware] }),
        params,
        requestId,
        createMiddlewareStateBag(),
        declared,
        async () => ({ value: 'never' }),
      ),
    ).rejects.toMatchObject({ type: 'rate_limited', message: 'slow down' });
  });

  it('a plain thrown value recognized as a network transport error keeps that classification (retryable) when thrown from wrap before next() resolves', async () => {
    const middleware: VernLLMMiddleware = {
      name: 'flaky-external-call',
      wrap: async () => {
        // Simulates a middleware wrapping its own external call (e.g. a
        // redaction microservice) that failed transiently, the same
        // network signal normalizeError already recognizes for the LLM
        // provider client itself.
        const networkError = Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' });
        throw networkError;
      },
    };

    try {
      await runOperation(
        dependencies({ middleware: [middleware] }),
        params,
        requestId,
        createMiddlewareStateBag(),
        declared,
        async () => ({ value: 'never' }),
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(LLMError);
      const llmError = error as LLMError;
      expect(llmError.type).not.toBe('invalid_params');
      expect(llmError.type).not.toBe('unknown');
      expect(llmError.retryable).toBe(true);
    }
  });

  it('a wrap throwing after next() already resolved successfully keeps the original result and logs the error', async () => {
    const logger = fakeLogger();

    const middleware: VernLLMMiddleware = {
      name: 'post-fail',
      wrap: async (_request, next) => {
        await next();
        throw new Error('post-processing bug');
      },
    };

    const outcome = await runOperation(
      dependencies({ middleware: [middleware], logger }),
      params,
      requestId,
      createMiddlewareStateBag(),
      declared,
      async () => ({ value: 'the real result' }),
    );

    expect(outcome).toEqual({ value: 'the real result' });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('post-fail'),
      expect.objectContaining({ message: 'post-processing bug' }),
    );
  });

  it('ctx.state is shared across every middleware in the chain via the same MiddlewareStateBag', async () => {
    const state = createMiddlewareStateBag();
    let seenInSecond: unknown;

    const first: VernLLMMiddleware = {
      name: 'first',
      priority: 0,
      wrap: async (_request, next, ctx) => {
        expect(ctx.state).toBe(state);
        return next();
      },
    };

    const second: VernLLMMiddleware = {
      name: 'second',
      priority: 1,
      wrap: async (_request, next, ctx) => {
        seenInSecond = ctx.state;
        return next();
      },
    };

    await runOperation(
      dependencies({ middleware: [first, second] }),
      params,
      requestId,
      state,
      declared,
      async () => ({ value: 'ok' }),
    );

    expect(seenInSecond).toBe(state);
  });

  it("ctx.registeredMiddlewareNames lists every registered middleware's resolved label, in transformOrder", async () => {
    let seenNames: readonly string[] = [];

    const first: VernLLMMiddleware = {
      name: 'first',
      priority: 0,
      wrap: async (_request, next, ctx) => {
        seenNames = ctx.registeredMiddlewareNames;
        return next();
      },
    };
    const second: VernLLMMiddleware = { name: 'second', priority: 1 };

    await runOperation(
      dependencies({ middleware: [first, second] }),
      params,
      requestId,
      createMiddlewareStateBag(),
      declared,
      async () => ({ value: 'ok' }),
    );

    expect(seenNames).toEqual(['first', 'second']);
  });

  it('ctx is a PreDispatchContext describing the primary target only, since wrap runs before next() decides the real target', async () => {
    let seenContext: unknown;

    const middleware: VernLLMMiddleware = {
      name: 'mw',
      wrap: async (_request, next, ctx) => {
        seenContext = ctx;
        return next();
      },
    };

    await runOperation(
      dependencies({ middleware: [middleware] }),
      params,
      requestId,
      createMiddlewareStateBag(),
      declared,
      async () => ({ value: 'ok' }),
    );

    expect(seenContext).toMatchObject({
      stage: 'pre-dispatch',
      requestId,
      primaryProvider: 'primary',
      primaryModel: 'default-model',
      capabilities: { supportsJsonObjectMode: true },
    });
    // No isFallbackAttempt/attempt/requestedProvider/requestedModel at
    // all: PreDispatchContext doesn't carry fields that would only ever
    // report a placeholder value.
    expect(seenContext).not.toHaveProperty('isFallbackAttempt');
    expect(seenContext).not.toHaveProperty('attempt');
    expect(seenContext).not.toHaveProperty('requestedProvider');
    expect(seenContext).not.toHaveProperty('requestedModel');
  });

  it('Rule 3: keeps the resolved result and logs "unknown" when wrap throws a non-Error after next() already resolved', async () => {
    const logger = fakeLogger();
    const middleware: VernLLMMiddleware = {
      name: 'mw',
      wrap: async (_request, next) => {
        await next();
        throw 'not an Error instance';
      },
    };
    const coreOperation = vi.fn(async () => ({ value: 'resolved' }) satisfies CallResult);

    const outcome = await runOperation(
      dependencies({ middleware: [middleware], logger }),
      params,
      requestId,
      createMiddlewareStateBag(),
      declared,
      coreOperation,
    );

    expect(outcome).toEqual({ value: 'resolved' });
    expect(logger.error).toHaveBeenCalledWith(
      '[VernLLM] middleware "mw".wrap threw after next() resolved; keeping the original result',
      { message: 'unknown' },
    );
  });
});

describe('runOperation, target order', () => {
  function fakeTarget(name: string, index: number): ResolvedTarget {
    return {
      index,
      executor: {
        providerName: name,
        model: `${name}-model`,
        adapter: { name: `${name}-adapter` },
        jsonObjectModeSupported: true,
        previewRequest: primary.previewRequest,
      } as unknown as CallExecutor,
    };
  }

  const [a, b, c] = [fakeTarget('a', 0), fakeTarget('b', 1), fakeTarget('c', 2)] as [
    ResolvedTarget,
    ResolvedTarget,
    ResolvedTarget,
  ];
  const all = [a, b, c];
  const targetNames = (targets: readonly TargetInfo[]) => targets.map((target) => target.name);
  const executorNames = (targets: readonly ResolvedTarget[]) =>
    targets.map((target) => target.executor.providerName);

  /** Runs `middleware` around a core that records the order it is handed. */
  async function run(
    middleware: VernLLMMiddleware[],
    options: { start?: ResolvedTarget[]; logger?: Logger; params?: CallParams<unknown> } = {},
  ) {
    const core = vi.fn(async (_targets: readonly ResolvedTarget[]) => ({ value: 'ok' }));

    const outcome = await runOperation(
      dependencies({ middleware, targets: all, logger: options.logger }),
      options.params ?? params,
      requestId,
      createMiddlewareStateBag(),
      options.start ?? all,
      core,
    );

    return { outcome, core, handed: () => executorNames(core.mock.calls[0]![0]) };
  }

  it('hands the starting order to coreOperation untouched when there is no wrap to narrow it', async () => {
    const { handed } = await run([], { start: [c, a] });

    expect(handed()).toEqual(['c', 'a']);
  });

  it('hands the starting order to coreOperation when cachedCall already wraps this invocation', async () => {
    const core = vi.fn(async () => ({ value: 'ok' }));
    const narrow: VernLLMMiddleware = {
      name: 'narrow',
      wrap: (_request, next) => next({ targets: ['b'] }),
    };

    await runOperation(
      dependencies({ middleware: [narrow], targets: all }),
      params,
      requestId,
      createMiddlewareStateBag(),
      [c, a],
      core,
      true,
    );

    expect(core).toHaveBeenCalledWith([c, a]);
  });

  it('shows a wrap the order it starts with as ctx.targets, with name, declared index, model and adapter', async () => {
    let seen: unknown;

    await run(
      [
        {
          name: 'observer',
          wrap: (_request, next, ctx) => {
            seen = ctx.targets;
            return next();
          },
        },
      ],
      { start: [c, a] },
    );

    expect(seen).toEqual([
      { name: 'c', index: 2, model: 'c-model', adapter: { name: 'c-adapter' } },
      { name: 'a', index: 0, model: 'a-model', adapter: { name: 'a-adapter' } },
    ]);
  });

  it('shows the per call model on the primary only', async () => {
    let seen: Array<{ name: string; model: string }> = [];

    await run(
      [
        {
          name: 'observer',
          wrap: (_request, next, ctx) => {
            seen = ctx.targets.map(({ name, model }) => ({ name, model }));
            return next();
          },
        },
      ],
      { params: { ...params, model: 'override-model' } },
    );

    expect(seen).toEqual([
      { name: 'a', model: 'override-model' },
      { name: 'b', model: 'b-model' },
      { name: 'c', model: 'c-model' },
    ]);
  });

  it('hands coreOperation the order left by next({ targets }), reordering and dropping by name', async () => {
    const { handed } = await run([
      { name: 'router', wrap: (_request, next) => next({ targets: ['c', 'a'] }) },
    ]);

    expect(handed()).toEqual(['c', 'a']);
  });

  it('keeps the order it received when next() is called without targets', async () => {
    const { handed } = await run(
      [
        { name: 'plain', wrap: (_request, next) => next() },
        { name: 'empty', wrap: (_request, next) => next({}) },
      ],
      { start: [b, c] },
    );

    expect(handed()).toEqual(['b', 'c']);
  });

  it('narrows across nested wraps, each seeing what the ones outside it left', async () => {
    const seenByInner: string[][] = [];

    const outer: VernLLMMiddleware = {
      name: 'outer',
      position: 'outermost',
      wrap: (_request, next) => next({ targets: ['c', 'b'] }),
    };
    const inner: VernLLMMiddleware = {
      name: 'inner',
      position: 'innermost',
      wrap: (_request, next, ctx) => {
        seenByInner.push(targetNames(ctx.targets));
        return next({ targets: ['b'] });
      },
    };

    const { handed } = await run([inner, outer]);

    expect(seenByInner).toEqual([['c', 'b']]);
    expect(handed()).toEqual(['b']);
  });

  it('passes the order through a middleware that is disabled or has no wrap', async () => {
    const seen: string[][] = [];

    const outer: VernLLMMiddleware = {
      name: 'outer',
      position: 'outermost',
      wrap: (_request, next) => next({ targets: ['c'] }),
    };
    const disabled: VernLLMMiddleware = {
      name: 'disabled',
      enabled: false,
      wrap: (_request, next) => next({ targets: ['a'] }),
    };
    const transformOnly: VernLLMMiddleware = { name: 'transform-only', transform: () => ({}) };
    const inner: VernLLMMiddleware = {
      name: 'inner',
      position: 'innermost',
      wrap: (_request, next, ctx) => {
        seen.push(targetNames(ctx.targets));
        return next();
      },
    };

    const { handed } = await run([inner, transformOnly, disabled, outer]);

    expect(seen).toEqual([['c']]);
    expect(handed()).toEqual(['c']);
  });

  it('drops a target an outer wrap removed instead of adding it back, logging its name once', async () => {
    const logger = fakeLogger();

    const outer: VernLLMMiddleware = {
      name: 'outer',
      position: 'outermost',
      wrap: (_request, next) => next({ targets: ['a', 'b'] }),
    };
    const inner: VernLLMMiddleware = {
      name: 'inner',
      position: 'innermost',
      wrap: (_request, next) => next({ targets: ['c', 'b'] }),
    };

    const { handed } = await run([inner, outer], { logger });

    expect(handed()).toEqual(['b']);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      '[VernLLM:req-1] middleware "inner" asked for target "c", which an outer layer removed; ignoring it',
    );
  });

  it.each([
    ['an unknown name', ['nope'], 'unknown_target'],
    ['an empty order', [], 'no_eligible_targets'],
    ['a repeated name', ['a', 'a'], 'no_eligible_targets'],
  ])(
    'rejects %s from next() with its own code, and never runs coreOperation',
    async (_label, targets, code) => {
      const core = vi.fn(async () => ({ value: 'never' }));

      await expect(
        runOperation(
          dependencies({ middleware: [{ name: 'bad', wrap: (_r, next) => next({ targets }) }] }),
          params,
          requestId,
          createMiddlewareStateBag(),
          all,
          core,
        ),
      ).rejects.toMatchObject({ type: 'invalid_params', code });
      expect(core).not.toHaveBeenCalled();
    },
  );

  it('rejects with no_eligible_targets when every target an inner wrap asks for was removed', async () => {
    const outer: VernLLMMiddleware = {
      name: 'outer',
      position: 'outermost',
      wrap: (_request, next) => next({ targets: ['a'] }),
    };
    const inner: VernLLMMiddleware = {
      name: 'inner',
      position: 'innermost',
      wrap: (_request, next) => next({ targets: ['b', 'c'] }),
    };

    await expect(run([inner, outer])).rejects.toMatchObject({
      type: 'invalid_params',
      code: 'no_eligible_targets',
    });
  });

  it('counts only the first next() call: later calls get its result, not their own targets', async () => {
    const twice: VernLLMMiddleware = {
      name: 'twice',
      wrap: async (_request, next) => {
        const first = await next({ targets: ['b'] });
        await next({ targets: ['c'] });
        return first;
      },
    };

    const { core, handed } = await run([twice]);

    expect(core).toHaveBeenCalledTimes(1);
    expect(handed()).toEqual(['b']);
  });

  it('memoizes a rejected first next() call too, so a retry inside the wrap gets the same error', async () => {
    const retrying: VernLLMMiddleware = {
      name: 'retrying',
      wrap: async (_request, next) => {
        await next({ targets: ['nope'] }).catch(() => {});
        return next({ targets: ['a'] });
      },
    };

    await expect(run([retrying])).rejects.toMatchObject({ code: 'unknown_target' });
  });
});

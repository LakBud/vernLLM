import { describe, expect, it, vi } from 'vitest';

import {
  runOperation,
  type RunOperationDependencies,
} from '../../../../src/internal/execution/runOperation.js';
import { LLMError } from '../../../../src/types/errors.js';
import { createMiddlewareStateBag } from '../../../../src/types/middleware.js';

import type { CallExecutor } from '../../../../src/internal/execution/callExecutor.js';
import type { Logger } from '../../../../src/logger.js';
import type {
  CallParams,
  CallResult,
  VernLLMEvent,
  VernLLMMiddleware,
} from '../../../../src/types/index.js';

/**
 * Only `providerName`, `model`, and `previewRequest` are ever touched by
 * `runOperation`; everything else is intentionally absent so a test
 * fails loudly if `runOperation` starts relying on something new.
 */
function fakePrimaryExecutor(): CallExecutor {
  return {
    providerName: 'primary',
    model: 'default-model',
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

function dependencies(overrides: Partial<RunOperationDependencies> = {}): RunOperationDependencies {
  return {
    middleware: overrides.middleware ?? [],
    primaryExecutor: overrides.primaryExecutor ?? fakePrimaryExecutor(),
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
      coreOperation,
    );

    expect(outcome).toEqual({ value: 'canned' });
    expect(coreOperation).not.toHaveBeenCalled();
    expect(events).toEqual([
      { kind: 'middleware', requestId, middleware: 'short-circuit', hook: 'wrap_short_circuit' },
    ]);
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
      async () => ({ value: 'ok' }),
    );

    expect(outcome).toEqual({ value: 'ok' });
    expect(wrap).not.toHaveBeenCalled();
    expect(events).toEqual([
      { kind: 'middleware', requestId, middleware: 'disabled', hook: 'enabled_skip' },
    ]);
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
      async () => ({ value: 'ok' }),
    );

    expect(seenInSecond).toBe(state);
  });

  it("ctx describes the primary target and attempt 1, matching MiddlewareContext's documented pre-next() caveat for wrap", async () => {
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
      async () => ({ value: 'ok' }),
    );

    expect(seenContext).toMatchObject({
      requestId,
      requestedProvider: 'primary',
      requestedModel: 'default-model',
      isFallbackAttempt: false,
      attempt: 1,
      capabilities: { supportsJsonObjectMode: true },
    });
  });
});

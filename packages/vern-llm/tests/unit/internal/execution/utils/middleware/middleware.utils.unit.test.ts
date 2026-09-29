import { describe, expect, it, vi } from 'vitest';

import {
  applyMiddlewareTransforms,
  middlewareLabel,
  reclassifyMiddlewareThrow,
  resolveEnabled,
  runTransform,
  withOwn,
} from '../../../../../../src/internal/execution/utils/middleware/middleware.utils.js';
import { registerCallScope } from '../../../../../../src/internal/utils/callScope.utils.js';
import { LLMError } from '../../../../../../src/types/errors.js';
import { baseCtx, baseRequest, logger } from './middleware.helpers.js';

import type {
  MiddlewareStateBag,
  VernLLMEvent,
  VernLLMMiddleware,
} from '../../../../../../src/types/index.js';
import type { WireCallRequest } from '../../../../../../src/types/middleware.js';

describe('middlewareLabel', () => {
  it('uses the name when set', () => {
    expect(middlewareLabel({ name: 'my-mw' }, 3)).toBe('my-mw');
  });

  it('falls back to the array index when unnamed', () => {
    expect(middlewareLabel({}, 2)).toBe('[2]');
  });
});

describe('withOwn', () => {
  it('gives one entry the same scratch object for every hook of a call, and another entry its own', () => {
    const ctx = baseCtx();
    const first: VernLLMMiddleware = { name: 'first' };
    const second: VernLLMMiddleware = { name: 'second' };

    withOwn(ctx, first, 'first').own.seen = true;

    expect(withOwn(ctx, first, 'first').own).toEqual({ seen: true });
    expect(withOwn(ctx, second, 'second').own).toEqual({});
  });

  it('does not share scratch objects between calls, which have their own state bags', () => {
    const entry: VernLLMMiddleware = { name: 'entry' };

    withOwn(baseCtx(), entry, 'entry').own.seen = true;

    expect(withOwn(baseCtx(), entry, 'entry').own).toEqual({});
  });

  it("binds emit to the middleware's label and hands the call's scope the context it was built from", () => {
    const ctx = baseCtx();
    const emitCustom = vi.fn();
    registerCallScope(ctx.state, { context: undefined, emitCustom });

    withOwn(ctx, { name: 'router' }, 'router').emit('router.decision', { deployment: 'claude' });

    expect(emitCustom).toHaveBeenCalledExactlyOnceWith(
      'router.decision',
      { deployment: 'claude' },
      'router',
      ctx,
    );
  });

  it('binds a different label for each entry, even on the same context', () => {
    const ctx = baseCtx();
    const emitCustom = vi.fn();
    registerCallScope(ctx.state, { context: undefined, emitCustom });

    withOwn(ctx, { name: 'a' }, 'a').emit('one');
    withOwn(ctx, {}, '[1]').emit('two');

    expect(emitCustom.mock.calls.map((call) => call[2])).toEqual(['a', '[1]']);
  });

  it('keeps every other context field as it was', () => {
    const ctx = baseCtx({ requestId: 'req-9', attempt: 3 });

    expect(withOwn(ctx, { name: 'a' }, 'a')).toMatchObject({
      stage: 'attempt',
      requestId: 'req-9',
      attempt: 3,
      state: ctx.state,
    });
  });
});

describe('resolveEnabled', () => {
  it('defaults to enabled when unset', async () => {
    const result = await resolveEnabled({}, baseCtx(), 'mw', 5000, logger);
    expect(result).toBe(true);
  });

  it('returns a static boolean as-is', async () => {
    expect(await resolveEnabled({ enabled: false }, baseCtx(), 'mw', 5000, logger)).toBe(false);
    expect(await resolveEnabled({ enabled: true }, baseCtx(), 'mw', 5000, logger)).toBe(true);
  });

  it('awaits an async predicate', async () => {
    const result = await resolveEnabled(
      { enabled: async () => true },
      baseCtx(),
      'mw',
      5000,
      logger,
    );
    expect(result).toBe(true);
  });

  it('treats a throwing predicate as disabled and logs it', async () => {
    const errorLogger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await resolveEnabled(
      {
        enabled: () => {
          throw new Error('boom');
        },
      },
      baseCtx(),
      'flaky',
      5000,
      errorLogger,
    );
    expect(result).toBe(false);
    expect(errorLogger.error).toHaveBeenCalledTimes(1);
    expect(errorLogger.error.mock.calls[0]![0]).toContain('flaky');
  });

  it('falls back to an undefined stack when the predicate throws a non-Error value', async () => {
    const errorLogger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await resolveEnabled(
      {
        enabled: () => {
          throw 'not an Error instance';
        },
      },
      baseCtx(),
      'flaky',
      5000,
      errorLogger,
    );
    expect(result).toBe(false);
    expect(errorLogger.error).toHaveBeenCalledWith(expect.stringContaining('flaky'), {
      message: 'unknown',
      stack: undefined,
    });
  });

  it('treats a timed-out predicate as disabled', async () => {
    const errorLogger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await resolveEnabled(
      { enabled: () => new Promise(() => {}) },
      baseCtx(),
      'slow',
      10,
      errorLogger,
    );
    expect(result).toBe(false);
    expect(errorLogger.error).toHaveBeenCalledTimes(1);
  });

  it('a per-middleware timeoutMs overrides the instance middlewareTimeoutMs', async () => {
    const errorLogger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const start = Date.now();
    const result = await resolveEnabled(
      { enabled: () => new Promise(() => {}), timeoutMs: 15 },
      baseCtx(),
      'slow',
      100000,
      errorLogger,
    );
    expect(Date.now() - start).toBeLessThan(1000);
    expect(result).toBe(false);
  });

  it('timeoutMs <= 0 is treated as unbounded, never rejecting on a timer', async () => {
    vi.useFakeTimers();
    try {
      const errorLogger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

      // Resolves well after any nominal timeout would have fired, so a
      // `Promise.resolve(true)` shortcut can't hide a timer that was
      // scheduled and just happened not to win the race yet.
      const pending = resolveEnabled(
        { enabled: () => new Promise((resolve) => setTimeout(() => resolve(true), 50_000)) },
        baseCtx(),
        'unbounded',
        0,
        errorLogger,
      );

      await vi.advanceTimersByTimeAsync(50_000);
      const result = await pending;

      expect(result).toBe(true);
      expect(errorLogger.error).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('reclassifyMiddlewareThrow', () => {
  it('passes an already-built LLMError through with its own type intact', () => {
    const original = new LLMError('rate limited', 'rate_limited');
    const result = reclassifyMiddlewareThrow(original, 'mw');
    expect(result).toBe(original);
  });

  it('passes through a recognizable network-style error with its own classification', () => {
    const netErr = Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' });
    const result = reclassifyMiddlewareThrow(netErr, 'mw');
    expect(result.type).not.toBe('unknown');
  });

  it('reclassifies a genuinely unrecognizable throw to invalid_params, naming the middleware', () => {
    const result = reclassifyMiddlewareThrow(new Error('a plain bug'), 'my-middleware');
    expect(result.type).toBe('invalid_params');
    expect(result.code).toBe('middleware_threw');
    expect(result.message).toContain('my-middleware');
    expect(result.retryable).toBe(false);
  });
});

describe('runTransform', () => {
  it('returns an empty patch when the middleware has no transform', async () => {
    const result = await runTransform({}, baseRequest, baseCtx(), 'no-transform', 5000);
    expect(result).toEqual({});
  });

  it('classifies a timed-out transform as a non-retryable middleware_timeout', async () => {
    await expect(
      runTransform(
        { transform: () => new Promise(() => {}) },
        baseRequest,
        baseCtx(),
        'slow-transform',
        10,
      ),
    ).rejects.toMatchObject({
      type: 'timeout',
      code: 'middleware_timeout',
      retryable: false,
    });
  });
});

describe('applyMiddlewareTransforms', () => {
  const state: MiddlewareStateBag = { get: () => undefined, set: () => {} };

  function baseParams(overrides: Partial<Parameters<typeof applyMiddlewareTransforms>[0]> = {}) {
    return {
      request: baseRequest,
      requestId: 'req-1',
      attempt: 0,
      signal: undefined,
      state,
      middleware: [],
      middlewareTimeoutMs: 5000,
      logger,
      reportEvent: vi.fn(),
      buildContext: (
        attempt: number,
        signal: AbortSignal | undefined,
        contextState: MiddlewareStateBag,
      ) => baseCtx({ attempt: attempt + 1, signal, state: contextState }),
      ...overrides,
    };
  }

  it('returns the request unchanged when there is no middleware', async () => {
    const result = await applyMiddlewareTransforms(baseParams({ middleware: [] }));
    expect(result).toBe(baseRequest);
  });

  it('skips a middleware that has no transform, leaving the request unchanged', async () => {
    const onEvent = vi.fn();
    const middleware: VernLLMMiddleware[] = [{ name: 'observer-only', onEvent }];

    const result = await applyMiddlewareTransforms(baseParams({ middleware }));

    expect(result).toBe(baseRequest);
  });

  it("runs transforms in the order it's handed, trusting it without re-sorting", async () => {
    const order: string[] = [];
    // Deliberately in an order a raw `priority` sort would *not*
    // produce (descending priority), to prove `applyMiddlewareTransforms`
    // no longer re-sorts by `priority` itself: order is decided once,
    // upstream, by `resolveMiddlewareOrder`/`buildMiddlewarePipeline`.
    const middleware: VernLLMMiddleware[] = [
      {
        name: 'high',
        priority: 10,
        transform: () => {
          order.push('high');
          return {};
        },
      },
      {
        name: 'low',
        priority: 1,
        transform: () => {
          order.push('low');
          return {};
        },
      },
      {
        name: 'no-priority',
        transform: () => {
          order.push('no-priority');
          return {};
        },
      },
    ];

    await applyMiddlewareTransforms(baseParams({ middleware }));

    expect(order).toEqual(['high', 'low', 'no-priority']);
  });

  it("merges each patch in before the next middleware runs, so a later one sees an earlier one's change", async () => {
    const seenTemperatures: (number | undefined)[] = [];
    const middleware: VernLLMMiddleware[] = [
      {
        name: 'first',
        priority: 0,
        transform: (request) => {
          seenTemperatures.push(request.temperature);
          return { temperature: 0.5 };
        },
      },
      {
        name: 'second',
        priority: 1,
        transform: (request) => {
          seenTemperatures.push(request.temperature);
          return {};
        },
      },
    ];

    const result = await applyMiddlewareTransforms(baseParams({ middleware }));

    expect(seenTemperatures).toEqual([undefined, 0.5]);
    expect(result.temperature).toBe(0.5);
  });

  it("a transform that mutates the request it receives (e.g. pushing onto messages) never touches the caller's original request, since each transform receives a clone", async () => {
    const originalMessagesSnapshot = [...baseRequest.messages];
    const middleware: VernLLMMiddleware[] = [
      {
        name: 'mutator',
        transform: (request) => {
          // Deliberately mutates the array in place instead of returning
          // a patch, simulating a badly-behaved (or malicious) middleware.
          (request.messages as unknown[]).push({ role: 'user', content: 'injected' });
          return {};
        },
      },
    ];

    const result = await applyMiddlewareTransforms(baseParams({ middleware }));

    expect(baseRequest.messages).toEqual(originalMessagesSnapshot);
    expect(result.messages).toEqual(originalMessagesSnapshot);
  });

  it('emits an enabled_skip event and skips the transform when enabled resolves false', async () => {
    const reportEvent = vi.fn();
    const transform = vi.fn(() => ({ temperature: 0.9 }));
    const middleware: VernLLMMiddleware[] = [{ name: 'skip-me', enabled: false, transform }];

    await applyMiddlewareTransforms(baseParams({ middleware, reportEvent }));

    expect(transform).not.toHaveBeenCalled();
    expect(reportEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'middleware',
        middleware: 'skip-me',
        hook: 'enabled_skip',
      }) as VernLLMEvent,
    );
  });

  it('does not emit enabled_skip when enabled was never set (implicit true)', async () => {
    const reportEvent = vi.fn();
    const middleware: VernLLMMiddleware[] = [{ name: 'always-on', transform: () => ({}) }];

    await applyMiddlewareTransforms(baseParams({ middleware, reportEvent }));

    expect(reportEvent).not.toHaveBeenCalled();
  });

  it('does not emit enabled_skip when `enabled` reads as undefined by the time it is re-checked, even though resolveEnabled saw it defined', async () => {
    // `enabled` is read twice: once inside resolveEnabled to decide
    // whether the middleware runs, and again afterward to decide whether
    // to report the enabled_skip event. A getter that changes what it
    // returns between those two reads exercises the branch where the
    // second read no longer sees a defined `enabled`.
    const reportEvent = vi.fn();
    let reads = 0;
    const middlewareEntry: VernLLMMiddleware = {
      name: 'shifting-enabled',
      transform: vi.fn(() => ({})),
      get enabled() {
        reads += 1;
        return reads === 1 ? false : undefined;
      },
    };

    await applyMiddlewareTransforms(baseParams({ middleware: [middlewareEntry], reportEvent }));

    expect(middlewareEntry.transform).not.toHaveBeenCalled();
    expect(reportEvent).not.toHaveBeenCalled();
  });

  it('emits a transform event listing patchedFields when a transform actually changes something', async () => {
    const reportEvent = vi.fn();
    const middleware: VernLLMMiddleware[] = [
      { name: 'set-temp', transform: () => ({ temperature: 0.3, max_tokens: 200 }) },
    ];

    await applyMiddlewareTransforms(baseParams({ middleware, reportEvent }));

    expect(reportEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'middleware',
        middleware: 'set-temp',
        hook: 'transform',
        patchedFields: expect.arrayContaining(['temperature', 'max_tokens']),
      }) as VernLLMEvent,
    );
  });

  it('does not emit a transform event when the patch changes nothing', async () => {
    const reportEvent = vi.fn();
    const middleware: VernLLMMiddleware[] = [{ name: 'noop', transform: () => ({}) }];

    await applyMiddlewareTransforms(baseParams({ middleware, reportEvent }));

    expect(reportEvent).not.toHaveBeenCalled();
  });

  it('throws when a transform introduces a duplicate tool name via addTools', async () => {
    const requestWithTool: WireCallRequest = {
      ...baseRequest,
      tools: [{ type: 'function', function: { name: 'search', description: '', parameters: {} } }],
    };
    const middleware: VernLLMMiddleware[] = [
      {
        name: 'dup-tool',
        transform: () => ({
          addTools: [
            { type: 'function', function: { name: 'search', description: '', parameters: {} } },
          ],
        }),
      },
    ];

    await expect(
      applyMiddlewareTransforms(baseParams({ request: requestWithTool, middleware })),
    ).rejects.toMatchObject({ type: 'invalid_params', code: 'duplicate_tool_names' });
  });

  it('rejects if a transform changes model, via assertModelAndResponseFormatUnchanged', async () => {
    const middleware: VernLLMMiddleware[] = [
      { name: 'bad', transform: () => ({ model: 'gpt-5' }) as never },
    ];

    await expect(applyMiddlewareTransforms(baseParams({ middleware }))).rejects.toMatchObject({
      type: 'invalid_params',
    });
  });
});

describe('applyMiddlewareTransforms, enabledEntries', () => {
  it('collects every entry enabled for the attempt, with or without a transform', async () => {
    const withTransform: VernLLMMiddleware = { name: 'a', transform: () => ({}) };
    const withoutTransform: VernLLMMiddleware = { name: 'b', dispatch: async (_r, next) => next() };
    const disabled: VernLLMMiddleware = { name: 'c', enabled: false, transform: () => ({}) };
    const enabledEntries = new Set<VernLLMMiddleware>();

    await applyMiddlewareTransforms({
      request: baseRequest,
      requestId: 'req-1',
      attempt: 0,
      signal: undefined,
      state: { get: () => undefined, set: () => {} },
      middleware: [withTransform, withoutTransform, disabled],
      middlewareTimeoutMs: 5000,
      logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
      reportEvent: vi.fn(),
      buildContext: () => baseCtx(),
      enabledEntries,
    });

    expect([...enabledEntries]).toEqual([withTransform, withoutTransform]);
  });
});

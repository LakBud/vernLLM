import { describe, expect, it, vi } from 'vitest';

import {
  createCallScope,
  MAX_CUSTOM_EVENTS_PER_CALL,
} from '../../../../../../src/internal/execution/utils/middleware/customEvent.utils.js';
import {
  emitEvent,
  withOwn,
} from '../../../../../../src/internal/execution/utils/middleware/middleware.utils.js';
import {
  callScopeFor,
  isJson,
  isPlainObject,
  noopEmit,
  prepareCallContext,
  registerCallScope,
  validateStateEntries,
} from '../../../../../../src/internal/utils/callScope.utils.js';
import { LLMError } from '../../../../../../src/types/errors.js';
import { createStateKey } from '../../../../../../src/types/middleware.js';
import { baseCtx, logger } from './middleware.helpers.js';

import type { VernLLMEvent, VernLLMMiddleware } from '../../../../../../src/types/index.js';

describe('emitEvent', () => {
  it('reports the event and returns without dispatching when there is no middleware', () => {
    const reportEvent = vi.fn();
    const event: VernLLMEvent = {
      kind: 'middleware',
      requestId: 'req-1',
      middleware: 'some-middleware',
      hook: 'enabled_skip',
    };

    emitEvent(event, baseCtx(), reportEvent, [], 1000, logger);

    expect(reportEvent).toHaveBeenCalledWith(event);
  });

  it('skips onEvent for a middleware whose enabled resolves false', async () => {
    const onEvent = vi.fn();
    const event: VernLLMEvent = {
      kind: 'middleware',
      requestId: 'req-1',
      middleware: 'some-middleware',
      hook: 'enabled_skip',
    };
    const middleware: VernLLMMiddleware[] = [{ name: 'disabled-mw', enabled: false, onEvent }];

    emitEvent(event, baseCtx(), () => {}, middleware, 1000, logger);

    await Promise.resolve();
    await Promise.resolve();

    expect(onEvent).not.toHaveBeenCalled();
  });

  it('logs and swallows an onEvent handler that throws synchronously, not just one that rejects', () => {
    const errorLogger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const event: VernLLMEvent = {
      kind: 'middleware',
      requestId: 'req-1',
      middleware: 'some-middleware',
      hook: 'enabled_skip',
    };
    const middleware: VernLLMMiddleware[] = [
      {
        name: 'throws-sync',
        onEvent: () => {
          throw new Error('sync boom');
        },
      },
    ];

    emitEvent(event, baseCtx(), () => {}, middleware, 1000, errorLogger);

    // A sync throw is caught and logged inside emitEvent itself, so nothing needs flushing.
    expect(errorLogger.error).toHaveBeenCalledWith(
      '[VernLLM] middleware "throws-sync".onEvent failed',
      expect.objectContaining({ message: 'sync boom' }),
    );
  });
});

describe('emitEvent delivery timing', () => {
  const event: VernLLMEvent = {
    kind: 'middleware',
    requestId: 'req-1',
    middleware: 'some-middleware',
    hook: 'enabled_skip',
  };

  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  it('runs static handlers in registration order before emitEvent returns', () => {
    const order: string[] = [];
    const middleware: VernLLMMiddleware[] = [
      { name: 'a', onEvent: () => void order.push('a') },
      { name: 'b', enabled: true, onEvent: () => void order.push('b') },
      { name: 'c', onEvent: () => void order.push('c') },
    ];

    emitEvent(event, baseCtx(), () => order.push('reported'), middleware, 1000, logger);
    order.push('returned');

    expect(order).toEqual(['reported', 'a', 'b', 'c', 'returned']);
  });

  it('does not let a slow async enabled on an earlier entry delay a later entry', async () => {
    vi.useFakeTimers();
    try {
      const seen: string[] = [];
      const middleware: VernLLMMiddleware[] = [
        {
          name: 'slow-predicate',
          enabled: () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 500)),
          onEvent: () => void seen.push('slow'),
        },
        { name: 'static', onEvent: () => void seen.push('static') },
      ];

      emitEvent(event, baseCtx(), () => {}, middleware, 5000, logger);

      expect(seen).toEqual(['static']);

      await vi.advanceTimersByTimeAsync(500);

      expect(seen).toEqual(['static', 'slow']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still calls a function enabled that resolves true, asynchronously', async () => {
    const onEvent = vi.fn();
    const middleware: VernLLMMiddleware[] = [
      { name: 'async-on', enabled: async () => true, onEvent },
    ];

    emitEvent(event, baseCtx(), () => {}, middleware, 1000, logger);

    expect(onEvent).not.toHaveBeenCalled();
    await flush();
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('never calls onEvent when an async enabled resolves false', async () => {
    const onEvent = vi.fn();
    const middleware: VernLLMMiddleware[] = [
      { name: 'async-off', enabled: async () => false, onEvent },
    ];

    emitEvent(event, baseCtx(), () => {}, middleware, 1000, logger);
    await flush();

    expect(onEvent).not.toHaveBeenCalled();
  });

  it('logs and treats as disabled an async enabled that throws', async () => {
    const errorLogger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const onEvent = vi.fn();
    const middleware: VernLLMMiddleware[] = [
      {
        name: 'bad-predicate',
        enabled: async () => {
          throw new Error('predicate boom');
        },
        onEvent,
      },
    ];

    emitEvent(event, baseCtx(), () => {}, middleware, 1000, errorLogger);
    await flush();

    expect(onEvent).not.toHaveBeenCalled();
    expect(errorLogger.error).toHaveBeenCalledWith(
      '[VernLLM] middleware "bad-predicate".enabled threw or timed out, treating as disabled',
      expect.objectContaining({ message: 'predicate boom' }),
    );
  });

  it('treats an async enabled that times out as disabled', async () => {
    vi.useFakeTimers();
    try {
      const errorLogger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const onEvent = vi.fn();
      const middleware: VernLLMMiddleware[] = [
        { name: 'hung-predicate', enabled: () => new Promise<boolean>(() => {}), onEvent },
      ];

      emitEvent(event, baseCtx(), () => {}, middleware, 50, errorLogger);
      await vi.advanceTimersByTimeAsync(50);

      expect(onEvent).not.toHaveBeenCalled();
      expect(errorLogger.error).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('isolates a throwing handler and a rejecting handler from each other and from later entries', async () => {
    const errorLogger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const later = vi.fn();
    const middleware: VernLLMMiddleware[] = [
      {
        name: 'throws',
        onEvent: () => {
          throw new Error('sync boom');
        },
      },
      { name: 'rejects', onEvent: () => Promise.reject(new Error('async boom')) },
      { name: 'later', onEvent: later },
    ];

    expect(() =>
      emitEvent(event, baseCtx(), () => {}, middleware, 1000, errorLogger),
    ).not.toThrow();
    await flush();

    expect(later).toHaveBeenCalledTimes(1);
    expect(errorLogger.error).toHaveBeenCalledWith(
      '[VernLLM] middleware "throws".onEvent failed',
      expect.objectContaining({ message: 'sync boom' }),
    );
    expect(errorLogger.error).toHaveBeenCalledWith(
      '[VernLLM] middleware "rejects".onEvent failed',
      expect.objectContaining({ message: 'async boom' }),
    );
  });

  it('passes each handler a fresh own object', () => {
    const owns: object[] = [];
    const middleware: VernLLMMiddleware[] = [
      { name: 'a', onEvent: (_e, ctx) => void owns.push(ctx.own) },
      { name: 'b', onEvent: (_e, ctx) => void owns.push(ctx.own) },
    ];

    emitEvent(event, baseCtx(), () => {}, middleware, 1000, logger);

    expect(owns).toHaveLength(2);
    expect(owns[0]).not.toBe(owns[1]);
  });
});

describe('ctx.emit', () => {
  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  /** A context whose state bag has a scope, with a logger of its own so warnings can be counted. */
  function scoped(middleware: VernLLMMiddleware[] = []) {
    const ctx = baseCtx();
    const reportEvent = vi.fn();
    const scopeLogger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

    registerCallScope(
      ctx.state,
      createCallScope(
        { reportEvent, middleware, middlewareTimeoutMs: 1000, logger: scopeLogger },
        undefined,
      ),
    );

    return { ctx, reportEvent, logger: scopeLogger };
  }

  it('reports a custom event to the instance reporter and every enabled middleware, the emitter included', () => {
    const seenByA = vi.fn();
    const seenByB = vi.fn();
    const disabled = vi.fn();
    const a: VernLLMMiddleware = { name: 'a', onEvent: seenByA };
    const b: VernLLMMiddleware = { name: 'b', onEvent: seenByB };
    const off: VernLLMMiddleware = { name: 'off', enabled: false, onEvent: disabled };
    const { ctx, reportEvent } = scoped([a, b, off]);

    withOwn(ctx, a, 'a').emit('router.decision', { deployment: 'claude', weight: 2 });

    const expected = {
      kind: 'custom',
      requestId: 'req-1',
      name: 'router.decision',
      source: 'a',
      data: { deployment: 'claude', weight: 2 },
    };

    expect(reportEvent).toHaveBeenCalledExactlyOnceWith(expected);
    expect(seenByA).toHaveBeenCalledExactlyOnceWith(expected, expect.anything());
    expect(seenByB).toHaveBeenCalledExactlyOnceWith(expected, expect.anything());
    expect(disabled).not.toHaveBeenCalled();
  });

  it("labels the event with the emitting middleware's own label", () => {
    const a: VernLLMMiddleware = { name: 'a' };
    const b: VernLLMMiddleware = {};
    const { ctx, reportEvent } = scoped([a, b]);

    withOwn(ctx, a, 'a').emit('one');
    withOwn(ctx, b, '[1]').emit('two');

    expect(reportEvent.mock.calls.map(([event]) => event.source)).toEqual(['a', '[1]']);
  });

  it('leaves data off the event when none is given', () => {
    const a: VernLLMMiddleware = { name: 'a' };
    const { ctx, reportEvent } = scoped([a]);

    withOwn(ctx, a, 'a').emit('router.decision');

    expect(reportEvent).toHaveBeenCalledExactlyOnceWith({
      kind: 'custom',
      requestId: 'req-1',
      name: 'router.decision',
      source: 'a',
    });
  });

  it('stays inert on the default emit of a context withOwn has not bound to a middleware yet', () => {
    const { ctx, reportEvent } = scoped([{ name: 'a' }]);

    noopEmit('router.decision', { x: 1 });

    expect(reportEvent).not.toHaveBeenCalled();
    expect(callScopeFor(ctx.state)).toBeDefined();
  });

  it('does nothing, and does not throw, for a state bag with no call scope', () => {
    const a: VernLLMMiddleware = { name: 'a' };

    expect(() => withOwn(baseCtx(), a, 'a').emit('router.decision', { x: 1 })).not.toThrow();
  });

  it('lets a middleware receive the event through its own context, bound to its own label', () => {
    const received: string[] = [];
    const emitter: VernLLMMiddleware = { name: 'emitter' };
    const listener: VernLLMMiddleware = {
      name: 'listener',
      onEvent: (event, ctx) => {
        if (event.kind === 'custom') received.push(`${event.source}>${typeof ctx.emit}`);
      },
    };
    const { ctx } = scoped([emitter, listener]);

    withOwn(ctx, emitter, 'emitter').emit('note');

    expect(received).toEqual(['emitter>function']);
  });

  // Built by assignment rather than a literal, which the linter flags.
  const arrayWithHole: unknown[] = new Array<unknown>(2);
  arrayWithHole[1] = 1;

  it.each([
    ['NaN', { a: Number.NaN }],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a function', () => 1],
    ['a symbol', Symbol('x')],
    ['a bigint', 10n],
    ['a nested undefined', { a: undefined }],
    ['a hole in an array', arrayWithHole],
    ['a Date', new Date(0)],
    ['a Map', new Map()],
    [
      'a class instance',
      new (class Point {
        x = 1;
      })(),
    ],
  ])('drops an event whose data holds %s', (_label, data) => {
    const a: VernLLMMiddleware = { name: 'a' };
    const { ctx, reportEvent, logger: scopeLogger } = scoped([a]);

    withOwn(ctx, a, 'a').emit('router.decision', data as never);

    expect(reportEvent).not.toHaveBeenCalled();
    expect(scopeLogger.warn).toHaveBeenCalledTimes(1);
  });

  it('drops data that refers back to itself, as an object or through an array', () => {
    const a: VernLLMMiddleware = { name: 'a' };
    const { ctx, reportEvent } = scoped([a]);
    const object: Record<string, unknown> = {};
    object.self = object;
    const array: unknown[] = [];
    array.push({ inner: array });

    withOwn(ctx, a, 'a').emit('router.decision', object as never);
    withOwn(ctx, a, 'a').emit('router.decision', array as never);

    expect(reportEvent).not.toHaveBeenCalled();
  });

  it('drops data nested deep enough to overflow the stack, instead of throwing', () => {
    const a: VernLLMMiddleware = { name: 'a' };
    const { ctx, reportEvent } = scoped([a]);
    let deep: unknown = [];
    for (let level = 0; level < 20_000; level++) deep = [deep];

    expect(() => withOwn(ctx, a, 'a').emit('router.decision', deep as never)).not.toThrow();
    expect(reportEvent).not.toHaveBeenCalled();
  });

  it.each([[''], [undefined], [42]])('drops an event named %j', (name) => {
    const a: VernLLMMiddleware = { name: 'a' };
    const { ctx, reportEvent } = scoped([a]);

    withOwn(ctx, a, 'a').emit(name as never);

    expect(reportEvent).not.toHaveBeenCalled();
  });

  it('warns about invalid input once per call, naming the call and the middleware', () => {
    const a: VernLLMMiddleware = { name: 'a' };
    const { ctx, logger: scopeLogger } = scoped([a]);

    withOwn(ctx, a, 'a').emit('', { ok: true });
    withOwn(ctx, a, 'a').emit('router.decision', { bad: Number.NaN });

    expect(scopeLogger.warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/^\[VernLLM:req-1\] middleware "a" called ctx\.emit with /),
    );
  });

  it('accepts JSON of every shape, including a null prototype and a value shared by two branches', () => {
    const a: VernLLMMiddleware = { name: 'a' };
    const { ctx, reportEvent } = scoped([a]);
    const shared = { n: 1 };
    const bare = Object.create(null) as Record<string, unknown>;
    bare.k = 'v';
    const data = {
      s: 'text',
      n: 0,
      t: true,
      f: false,
      nil: null,
      list: [1, [2]],
      bare,
      x: shared,
      y: shared,
    };

    withOwn(ctx, a, 'a').emit('router.decision', data as never);

    expect(reportEvent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ data }));
  });

  it('drops an emit made synchronously from a handler while a custom event is being delivered', () => {
    const seen: string[] = [];
    const looping: VernLLMMiddleware = {
      name: 'looping',
      onEvent: (event, ctx) => {
        if (event.kind !== 'custom') return;
        seen.push(event.name);
        ctx.emit('again');
      },
    };
    const { ctx, reportEvent, logger: scopeLogger } = scoped([looping]);

    withOwn(ctx, looping, 'looping').emit('first');

    expect(seen).toEqual(['first']);
    expect(reportEvent).toHaveBeenCalledTimes(1);
    expect(scopeLogger.warn).toHaveBeenCalledExactlyOnceWith(
      '[VernLLM:req-1] middleware "looping" emitted "again" while a custom event was being delivered, dropping it',
    );
  });

  it('warns about a re-entrant emit once per call, and delivers again once the first has finished', () => {
    const looping: VernLLMMiddleware = {
      name: 'looping',
      onEvent: (event, ctx) => {
        if (event.kind === 'custom' && event.name === 'first') {
          ctx.emit('again');
          ctx.emit('and again');
        }
      },
    };
    const { ctx, reportEvent, logger: scopeLogger } = scoped([looping]);

    withOwn(ctx, looping, 'looping').emit('first');
    withOwn(ctx, looping, 'looping').emit('second');

    expect(reportEvent.mock.calls.map(([event]) => event.name)).toEqual(['first', 'second']);
    expect(scopeLogger.warn).toHaveBeenCalledTimes(1);
  });

  it('still delivers later events when a handler threw during the previous one', () => {
    const throwing: VernLLMMiddleware = {
      name: 'throwing',
      onEvent: () => {
        throw new Error('boom');
      },
    };
    const { ctx, reportEvent } = scoped([throwing]);

    withOwn(ctx, throwing, 'throwing').emit('first');
    withOwn(ctx, throwing, 'throwing').emit('second');

    expect(reportEvent).toHaveBeenCalledTimes(2);
  });

  it('delivers at most the per call limit, dropping the rest with one warning', () => {
    const a: VernLLMMiddleware = { name: 'a' };
    const { ctx, reportEvent, logger: scopeLogger } = scoped([a]);

    for (let index = 0; index < MAX_CUSTOM_EVENTS_PER_CALL + 5; index++) {
      withOwn(ctx, a, 'a').emit('tick', { index });
    }

    expect(reportEvent).toHaveBeenCalledTimes(MAX_CUSTOM_EVENTS_PER_CALL);
    expect(scopeLogger.warn).toHaveBeenCalledExactlyOnceWith(
      `[VernLLM:req-1] middleware "a" emitted more than ${MAX_CUSTOM_EVENTS_PER_CALL} custom events in one call, dropping the rest`,
    );
  });

  it('counts the limit per call, so a second call delivers again', () => {
    const a: VernLLMMiddleware = { name: 'a' };
    const first = scoped([a]);
    const second = scoped([a]);

    for (let index = 0; index < MAX_CUSTOM_EVENTS_PER_CALL + 1; index++) {
      withOwn(first.ctx, a, 'a').emit('tick');
    }
    withOwn(second.ctx, a, 'a').emit('tick');

    expect(second.reportEvent).toHaveBeenCalledTimes(1);
    expect(second.logger.warn).not.toHaveBeenCalled();
  });

  it('does not count a dropped invalid event toward the limit', () => {
    const a: VernLLMMiddleware = { name: 'a' };
    const { ctx, reportEvent } = scoped([a]);

    for (let index = 0; index < MAX_CUSTOM_EVENTS_PER_CALL; index++) {
      withOwn(ctx, a, 'a').emit('', { index });
    }
    withOwn(ctx, a, 'a').emit('valid');

    expect(reportEvent).toHaveBeenCalledTimes(1);
  });

  it('stops a loop through an async enabled, whose delivery is deferred, at the limit', async () => {
    // The handler stops itself well past the limit, so a broken limit fails this test instead of
    // looping forever.
    const safetyValve = MAX_CUSTOM_EVENTS_PER_CALL * 5;
    let handled = 0;
    const looping: VernLLMMiddleware = {
      name: 'looping',
      enabled: async () => true,
      onEvent: (event, ctx) => {
        if (event.kind === 'custom' && ++handled < safetyValve) ctx.emit('again');
      },
    };
    const { ctx, reportEvent, logger: scopeLogger } = scoped([looping]);

    withOwn(ctx, looping, 'looping').emit('first');
    for (let round = 0; round < safetyValve * 2; round++) await flush();

    expect(reportEvent).toHaveBeenCalledTimes(MAX_CUSTOM_EVENTS_PER_CALL);
    expect(scopeLogger.warn).toHaveBeenCalledTimes(1);
  });
});

describe('isJson', () => {
  it('accepts the JSON value shapes', () => {
    expect(isJson(null)).toBe(true);
    expect(isJson('')).toBe(true);
    expect(isJson(0)).toBe(true);
    expect(isJson(false)).toBe(true);
    expect(isJson([])).toBe(true);
    expect(isJson({})).toBe(true);
    expect(isJson({ list: [1, { deep: [null] }] })).toBe(true);
  });

  it('rejects a cycle itself, without relying on the stack overflowing', () => {
    const object: Record<string, unknown> = {};
    object.self = object;
    const array: unknown[] = [];
    array.push([array]);

    expect(() => isJson(object)).not.toThrow();
    expect(isJson(object)).toBe(false);
    expect(isJson(array)).toBe(false);
  });

  it('accepts a value referenced twice, since that is not a cycle', () => {
    const shared = { n: 1 };

    expect(isJson([shared, shared])).toBe(true);
    expect(isJson({ a: shared, b: { c: shared } })).toBe(true);
  });

  it('rejects anything that is not plain JSON', () => {
    expect(isJson(undefined)).toBe(false);
    expect(isJson(Number.NaN)).toBe(false);
    expect(isJson(() => 1)).toBe(false);
    expect(isJson([undefined])).toBe(false);
    expect(isJson(new Date(0))).toBe(false);
  });
});

describe('isPlainObject', () => {
  it('accepts object literals and null prototype objects only', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject('text')).toBe(false);
    expect(isPlainObject(new Map())).toBe(false);
  });
});

describe('registerCallScope', () => {
  it('keeps the first scope when a bag is registered again, as cachedCall does with its inner call', () => {
    const ctx = baseCtx();
    const first = { context: undefined, emitCustom: vi.fn() };
    const second = { context: undefined, emitCustom: vi.fn() };

    registerCallScope(ctx.state, first);
    registerCallScope(ctx.state, second);

    expect(callScopeFor(ctx.state)).toBe(first);
  });

  it('finds no scope for a bag that was never registered', () => {
    expect(callScopeFor(baseCtx().state)).toBeUndefined();
  });
});

describe('prepareCallContext', () => {
  const invalid = (value: unknown) => {
    try {
      prepareCallContext(value);
    } catch (error) {
      return error as LLMError;
    }
    return undefined;
  };

  it('leaves an absent context absent', () => {
    expect(prepareCallContext(undefined)).toBeUndefined();
  });

  it('returns a clone, so the caller mutating their own object later changes nothing', () => {
    const original = { tenantId: 't1', routing: { only: ['bedrock'] } };
    const prepared = prepareCallContext(original)!;

    original.tenantId = 'changed';
    original.routing.only.push('openai');

    expect(prepared).toEqual({ tenantId: 't1', routing: { only: ['bedrock'] } });
    expect(prepared).not.toBe(original);
  });

  it('freezes every level, arrays included', () => {
    const prepared = prepareCallContext({ a: { b: [{ c: 1 }] } })! as {
      a: { b: { c: number }[] };
    };

    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.a)).toBe(true);
    expect(Object.isFrozen(prepared.a.b)).toBe(true);
    expect(Object.isFrozen(prepared.a.b[0])).toBe(true);
    expect(() => {
      prepared.a.b[0]!.c = 2;
    }).toThrow(TypeError);
  });

  it('accepts an empty object, JSON of every shape, and a null prototype object', () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.k = 'v';

    expect(prepareCallContext({})).toEqual({});
    expect(prepareCallContext({ s: 'x', n: 0, t: true, nil: null, list: [1, [2]], bare })).toEqual({
      s: 'x',
      n: 0,
      t: true,
      nil: null,
      list: [1, [2]],
      bare: { k: 'v' },
    });
  });

  it.each([
    ['null', null],
    ['a string', 'text'],
    ['a number', 1],
    ['an array', [1]],
    ['a function', () => 1],
    ['a Date', new Date(0)],
    ['a Map', new Map()],
    ['a nested function', { a: () => 1 }],
    ['a nested undefined', { a: undefined }],
    ['NaN', { a: Number.NaN }],
    ['Infinity', { a: Number.POSITIVE_INFINITY }],
    ['a bigint', { a: 10n }],
    [
      'a class instance',
      new (class Tenant {
        id = 't1';
      })(),
    ],
  ])('rejects %s as invalid_params, code invalid_context', (_label, value) => {
    const error = invalid(value);

    expect(error).toBeInstanceOf(LLMError);
    expect(error).toMatchObject({
      type: 'invalid_params',
      code: 'invalid_context',
      message: '`context` must be a plain JSON object',
    });
  });

  it('rejects a cycle, and data nested deep enough to overflow the stack, without throwing a RangeError', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let deep: unknown = {};
    for (let level = 0; level < 20_000; level++) deep = { deep };

    expect(invalid(cyclic)).toMatchObject({ code: 'invalid_context' });
    expect(invalid(deep)).toMatchObject({ code: 'invalid_context' });
  });
});

describe('call context stamping', () => {
  const context = Object.freeze({ tenantId: 't1' });
  const error = new LLMError('down', 'api', { code: 'server_error' });
  const usage = {
    promptTokens: 1,
    completionTokens: 2,
    totalTokens: 3,
    requestId: 'r',
    model: 'm',
  };

  const events: [string, VernLLMEvent][] = [
    [
      'retry',
      {
        kind: 'retry',
        requestId: 'r',
        provider: 'p',
        model: 'm',
        attempt: 1,
        maxRetries: 2,
        delayMs: 5,
        retryAfterHonored: false,
        error,
      },
    ],
    [
      'circuit_state',
      {
        kind: 'circuit_state',
        provider: 'p',
        model: 'm',
        from: 'closed',
        to: 'open',
        consecutiveFailures: 3,
      },
    ],
    [
      'fallback',
      {
        kind: 'fallback',
        requestId: 'r',
        from: 'a',
        to: 'b',
        fromIndex: -1,
        toIndex: 0,
        error,
        elapsedMs: 1,
      },
    ],
    [
      'rate_limited',
      {
        kind: 'rate_limited',
        requestId: 'r',
        provider: 'p',
        model: 'm',
        waitedMs: 1,
        reason: 'rpm',
      },
    ],
    ['middleware', { kind: 'middleware', requestId: 'r', middleware: 'x', hook: 'enabled_skip' }],
    ['custom', { kind: 'custom', requestId: 'r', name: 'n', source: 's', data: { a: 1 } }],
  ];

  it.each(events)(
    'stamps a %s event for the instance reporter and every middleware',
    (_kind, event) => {
      const reportEvent = vi.fn();
      const onEvent = vi.fn();

      emitEvent(event, baseCtx({ context }), reportEvent, [{ name: 'a', onEvent }], 1000, logger);

      expect(reportEvent).toHaveBeenCalledExactlyOnceWith({ ...event, context });
      expect(onEvent).toHaveBeenCalledExactlyOnceWith({ ...event, context }, expect.anything());
    },
  );

  it.each([
    ['usage', { kind: 'usage', requestId: 'r', usage } as VernLLMEvent],
    ['usage_failure', { kind: 'usage_failure', requestId: 'r', usage, error } as VernLLMEvent],
  ])('stamps a %s event and the TokenUsage inside it', (_kind, event) => {
    const reportEvent = vi.fn();

    emitEvent(event, baseCtx({ context }), reportEvent, [], 1000, logger);

    expect(reportEvent).toHaveBeenCalledExactlyOnceWith({
      ...event,
      context,
      usage: { ...usage, context },
    });
  });

  it('does not mutate the event it was given, or the usage inside it', () => {
    const event: VernLLMEvent = { kind: 'usage', requestId: 'r', usage: { ...usage } };

    emitEvent(event, baseCtx({ context }), vi.fn(), [], 1000, logger);

    expect(event).toEqual({ kind: 'usage', requestId: 'r', usage });
    expect(event).not.toHaveProperty('context');
    expect((event as { usage: object }).usage).not.toHaveProperty('context');
  });

  it.each(events)(
    'passes a %s event through untouched when the call has no context',
    (_kind, event) => {
      const reportEvent = vi.fn();

      emitEvent(event, baseCtx(), reportEvent, [], 1000, logger);

      expect(reportEvent.mock.calls[0]![0]).toBe(event);
    },
  );

  it('passes a usage event through untouched when the call has no context', () => {
    const event: VernLLMEvent = { kind: 'usage', requestId: 'r', usage };
    const reportEvent = vi.fn();

    emitEvent(event, baseCtx(), reportEvent, [], 1000, logger);

    expect(reportEvent.mock.calls[0]![0]).toBe(event);
    expect(reportEvent.mock.calls[0]![0].usage).toBe(usage);
  });
});

describe('validateStateEntries', () => {
  const key = createStateKey<string>('test.key');
  const rejection = (value: unknown) => {
    try {
      validateStateEntries(value);
    } catch (error) {
      return error as LLMError;
    }
    return undefined;
  };

  it('leaves an absent state absent', () => {
    expect(validateStateEntries(undefined)).toBeUndefined();
  });

  it('returns the same entries when they are valid, an empty array included', () => {
    const entries = [[key, 'a']] as const;

    expect(validateStateEntries(entries)).toBe(entries);
    expect(validateStateEntries([])).toEqual([]);
  });

  it('accepts any value, including undefined, next to a key', () => {
    expect(validateStateEntries([[key, undefined]])).toEqual([[key, undefined]]);
  });

  it.each([
    ['null', null],
    ['a plain object', {}],
    ['a string', 'x'],
    ['an entry that is not an array', [key]],
    ['a short entry', [[key]]],
    ['a long entry', [[key, 'a', 'b']]],
    ['a string key', [['k', 'a']]],
    ['a null key', [[null, 'a']]],
    ['a plain object key', [[{}, 'a']]],
    ['a key with a non string debugName', [[{ debugName: 1 }, 'a']]],
    ['a class instance key', [[new Date(), 'a']]],
  ])('rejects %s with a plain invalid_params', (_label, value) => {
    const error = rejection(value);

    expect(error).toBeInstanceOf(LLMError);
    expect(error).toMatchObject({ type: 'invalid_params', retryable: false });
    // Deliberately uncoded: it only happens when a caller bypasses the types.
    expect(error?.code).toBeUndefined();
  });
});

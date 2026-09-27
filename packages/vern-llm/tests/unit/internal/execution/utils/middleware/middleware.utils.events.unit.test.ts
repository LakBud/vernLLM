import { describe, expect, it, vi } from 'vitest';

import { emitEvent } from '../../../../../../src/internal/execution/utils/middleware/middleware.utils.js';
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

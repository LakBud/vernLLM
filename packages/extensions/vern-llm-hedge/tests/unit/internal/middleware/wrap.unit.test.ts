import {
  createMiddlewareStateBag,
  type CallResult,
  type PreDispatchContext,
  type WireCallRequest,
  type WrapNext,
} from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { hedgeLogFields, hedgeMiddleware } from '../../../../src/index.js';
import { captureLogger } from '../../../helpers.js';

// A real `VernLLM` always gives a `reruns` layer `next.again`, so the two places the hedge checks
// it again are driven with a stub `next`, the way a custom runner or a future core could.

const request: WireCallRequest = { model: 'm', max_tokens: 10, messages: [] };

function ctxOf(extra: Partial<PreDispatchContext> = {}) {
  const emitted: { name: string; data: unknown }[] = [];
  const ctx = {
    state: createMiddlewareStateBag(),
    emit: (name: string, data: unknown) => emitted.push({ name, data }),
    targets: [{ name: 'a' }, { name: 'b' }],
    streaming: false,
    ...extra,
  } as unknown as PreDispatchContext;
  return { ctx, emitted };
}

const later = (value: string, ms: number) =>
  new Promise<CallResult>((resolve) => setTimeout(() => resolve({ value }), ms));

function wrapOf(options: Parameters<typeof hedgeMiddleware>[0]) {
  return hedgeMiddleware({ logger: 'silent', ...options }).wrap!;
}

describe('without next.again', () => {
  it('runs the call as it is, and reports it as unavailable', async () => {
    const { ctx, emitted } = ctxOf();
    const next = (() => Promise.resolve({ value: 'plain' })) as unknown as WrapNext;

    const result = await wrapOf({ delay: 20 })(request, next, ctx);

    expect(result).toEqual({ value: 'plain' });
    expect(emitted).toEqual([{ name: 'hedge.decision', data: { v: 1, outcome: 'unavailable' } }]);
  });

  it('is unavailable when the reruns are used up during the delay', async () => {
    const { ctx, emitted } = ctxOf();
    let reads = 0;
    const next = (() => later('late', 40)) as unknown as WrapNext;
    // Read at the start, then again once the delay has passed: by then another layer has used
    // the call's last rerun.
    Object.defineProperty(next, 'again', {
      get: () => (reads++ === 0 ? () => Promise.resolve({ value: 'hedge' }) : undefined),
    });

    const result = await wrapOf({ delay: 10 })(request, next, ctx);

    expect(result).toEqual({ value: 'late' });
    expect(emitted).toEqual([
      { name: 'hedge.decision', data: { v: 1, outcome: 'unavailable', delayMs: 10 } },
    ]);
  });
});

describe('a hedge that cannot start', () => {
  it('counts as a hedge that failed, so the main chain still answers', async () => {
    const { ctx, emitted } = ctxOf();
    const next = (() => later('main', 40)) as unknown as WrapNext;
    Object.defineProperty(next, 'again', {
      get: () => () => {
        throw new Error('could not start');
      },
    });

    const result = await wrapOf({ delay: 10, budget: { ratio: 1, burst: 1 } })(request, next, ctx);

    expect(result).toEqual({ value: 'main' });
    expect(emitted[0]).toMatchObject({ data: { outcome: 'lost', target: 'b' } });
  });

  it('gives its budget token back, so the next hedge can still go out', async () => {
    const wrap = wrapOf({ delay: 10, budget: { ratio: 1, burst: 1 } });
    let starts = 0;
    const nextOf = (again: () => Promise<unknown>) => {
      const next = (() => later('main', 40)) as unknown as WrapNext;
      Object.defineProperty(next, 'again', { get: () => again });
      return next;
    };

    await wrap(
      request,
      nextOf(() => {
        throw new Error('could not start');
      }),
      ctxOf().ctx,
    );
    await wrap(
      request,
      nextOf(() => {
        starts++;
        return later('hedge', 0);
      }),
      ctxOf().ctx,
    );

    expect(starts).toBe(1);
  });
});

describe('a second hedge', () => {
  it('is not sent when the reruns are used up after the first hedge', async () => {
    const { ctx, emitted } = ctxOf({
      targets: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] as never,
    });
    let reads = 0;
    let sent = 0;
    const next = (() => later('main', 60)) as unknown as WrapNext;
    // Read at the start, for the first hedge, and for the second: the third read finds nothing.
    Object.defineProperty(next, 'again', {
      get: () =>
        reads++ < 2
          ? () => {
              sent++;
              return later('hedge', 200);
            }
          : undefined,
    });

    const result = await wrapOf({ delay: 10, maxHedges: 2, budget: { ratio: 1, burst: 4 } })(
      request,
      next,
      ctx,
    );

    expect(result).toEqual({ value: 'main' });
    expect(sent).toBe(1);
    expect(emitted[0]).toMatchObject({ data: { outcome: 'lost', target: 'b' } });
  });
});

describe('more hedges than targets', () => {
  it('sends as many hedges as there are names in targets, and no more', async () => {
    const { ctx, emitted } = ctxOf();
    let sent = 0;
    const next = (() => later('main', 60)) as unknown as WrapNext;
    Object.defineProperty(next, 'again', {
      get: () => () => {
        sent++;
        return later('hedge', 200);
      },
    });

    await wrapOf({ delay: 10, maxHedges: 3, budget: { ratio: 1, burst: 4 } })(request, next, ctx);

    // Two targets leave one name to hedge to.
    expect(sent).toBe(1);
    expect(emitted[0]).toMatchObject({ data: { outcome: 'lost', target: 'b' } });
  });
});

describe('cache awareness', () => {
  const usageEvent = (extra: Record<string, unknown> = {}) =>
    ({
      kind: 'usage',
      requestId: 'r',
      usage: { cacheReadTokens: 100, ...extra },
    }) as never;
  const plain = Object.assign(() => Promise.resolve({ value: 'plain' }), {
    again: () => Promise.resolve({ value: 'hedge' }),
  }) as unknown as WrapNext;

  it('counts a target that does not name itself as the primary', async () => {
    const middleware = hedgeMiddleware({ delay: 20, cacheAware: true, logger: 'silent' });
    const first = ctxOf({ targets: [{ name: 'primary' }, { name: 'b' }] as never });
    await middleware.wrap!(request, plain, first.ctx);

    middleware.onEvent!(usageEvent(), first.ctx as never);
    const second = ctxOf({ targets: [{ name: 'primary' }, { name: 'b' }] as never });
    await middleware.wrap!(request, plain, second.ctx);

    // The delay is doubled for a prefix the primary served from its cache.
    expect(second.emitted[0]).toMatchObject({ data: { delayMs: 40 } });
  });

  it('ignores usage on a call that never set a prefix, and usage without cache reads', async () => {
    const middleware = hedgeMiddleware({ delay: 20, cacheAware: true, logger: 'silent' });
    const first = ctxOf();
    await middleware.wrap!(request, plain, first.ctx);

    middleware.onEvent!(usageEvent(), ctxOf().ctx as never);
    middleware.onEvent!(usageEvent({ cacheReadTokens: 0 }), first.ctx as never);
    const second = ctxOf();
    await middleware.wrap!(request, plain, second.ctx);

    expect(second.emitted[0]).toMatchObject({ data: { delayMs: 20 } });
  });

  it('hedges as usual when the prefix cannot be read', async () => {
    const { ctx, emitted } = ctxOf();
    const unreadable = { ...request };
    Object.defineProperty(unreadable, 'messages', {
      get: () => {
        throw new Error('unreadable');
      },
    });

    await hedgeMiddleware({ delay: 20, cacheAware: true, logger: 'silent' }).wrap!(
      unreadable,
      plain,
      ctx,
    );

    expect(emitted[0]).toMatchObject({ data: { outcome: 'not_needed', delayMs: 20 } });
  });
});

describe('a signal that is already aborted', () => {
  it('does not hedge, since the call is being cancelled anyway', async () => {
    const { ctx, emitted } = ctxOf({ signal: AbortSignal.abort() });
    let hedged = false;
    const next = (() => later('main', 30)) as unknown as WrapNext;
    Object.defineProperty(next, 'again', {
      get: () => () => {
        hedged = true;
        return later('hedge', 0);
      },
    });

    await wrapOf({ delay: 5 })(request, next, ctx);

    expect(hedged).toBe(false);
    expect(emitted[0]).toMatchObject({ data: { outcome: 'aborted' } });
  });
});

describe('reporting', () => {
  it('never breaks the call, even when the event and the state cannot be written', async () => {
    const logs = captureLogger();
    const { ctx } = ctxOf({
      emit: () => {
        throw new Error('emit failed');
      },
      state: {
        get: () => undefined,
        set: () => {
          throw new Error('state failed');
        },
      },
    });
    const next = (() => Promise.resolve({ value: 'plain' })) as unknown as WrapNext;

    const result = await hedgeMiddleware({ delay: 20, logger: logs.logger }).wrap!(
      request,
      next,
      ctx,
    );

    expect(result).toEqual({ value: 'plain' });
    expect(logs.errors()).toHaveLength(2);
  });

  it('passes the main chain`s error through unchanged when the hedge was skipped', async () => {
    const { ctx, emitted } = ctxOf();
    const failure = new Error('provider failed');
    const next = (() => Promise.reject(failure)) as unknown as WrapNext;

    await expect(wrapOf({ delay: 20 })(request, next, ctx)).rejects.toBe(failure);
    expect(emitted).toHaveLength(1);
  });
});

describe('hedgeLogFields', () => {
  it('has nothing before the hedge has reported', () => {
    expect(hedgeLogFields({ state: createMiddlewareStateBag() })).toBeUndefined();
  });

  it('carries the outcome, and the delay when one was computed', async () => {
    const withDelay = ctxOf();
    const without = ctxOf();
    const answer = (() => Promise.resolve({ value: 'plain' })) as unknown as WrapNext;
    Object.defineProperty(answer, 'again', { get: () => () => later('hedge', 0) });

    await wrapOf({ delay: 20 })(request, answer, withDelay.ctx);
    await wrapOf({ delay: 20, targets: () => [] })(request, answer, without.ctx);

    expect(hedgeLogFields(withDelay.ctx)).toEqual({ hedge: 'not_needed', hedge_delay_ms: 20 });
    expect(hedgeLogFields(without.ctx)).toEqual({ hedge: 'no_target' });
  });
});

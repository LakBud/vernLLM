import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDelay } from '../../../../src/internal/delay/delay.utils.js';
import { StatsCache } from '../../../../src/internal/delay/statsCache.js';
import { createGuard } from '../../../../src/internal/guard.utils.js';
import { normalizeOptions } from '../../../../src/internal/options/normalizeOptions.utils.js';
import { captureLogger } from '../../../helpers.js';

import type { HedgeOptions } from '../../../../src/index.js';
import type { PreDispatchContext, WireCallRequest } from 'vern-llm';

type Filter = Readonly<Record<string, string>>;

/** A stats source over a table keyed by the filter's JSON, recording every read. */
function statsOf(table: Record<string, number | undefined>) {
  const reads: { filter: Filter; q: number; metric: string | undefined }[] = [];
  return {
    reads,
    source: {
      quantile: (filter: Filter, q: number, metric?: string) => {
        reads.push({ filter, q, metric });
        return table[JSON.stringify(Object.entries(filter).sort())];
      },
    },
  };
}

const key = (filter: Filter) => JSON.stringify(Object.entries(filter).sort());

function ctxOf(options: { streaming?: boolean; targets?: string[] } = {}) {
  return {
    streaming: options.streaming,
    targets: (options.targets ?? ['a', 'b']).map((name) => ({ name })),
  } as unknown as PreDispatchContext;
}

const small: WireCallRequest = {
  model: 'm',
  max_tokens: 1_000,
  messages: [{ role: 'user', content: 'x'.repeat(400) }],
};

function setup(options: HedgeOptions) {
  const { logger, warnings, errors } = captureLogger();
  const delay = createDelay(normalizeOptions({ ...options, logger }), createGuard(logger));
  return { delay, warnings, errors };
}

describe('a quantile delay', () => {
  it('reads the first target, stream mode and size bucket from attemptMs', () => {
    const { source, reads } = statsOf({
      [key({ provider: 'a', streaming: 'false', size: 'xs' })]: 840,
    });
    const { delay } = setup({ stats: source, delay: { quantile: 0.9 } });

    expect(delay.for(ctxOf(), small)).toBe(840);
    expect(reads).toEqual([
      { filter: { provider: 'a', streaming: 'false', size: 'xs' }, q: 0.9, metric: 'attemptMs' },
    ]);
  });

  it('reads the streamed series for a streamed call', () => {
    const { source } = statsOf({ [key({ provider: 'a', streaming: 'true', size: 'xs' })]: 300 });
    const { delay } = setup({ stats: source });

    expect(delay.for(ctxOf({ streaming: true }), small)).toBe(300);
    expect(delay.for(ctxOf({ streaming: false }), small)).toBeUndefined();
  });

  it('puts a long prompt in its own bucket', () => {
    const { source } = statsOf({
      [key({ provider: 'a', streaming: 'false', size: 'xs' })]: 200,
      [key({ provider: 'a', streaming: 'false', size: 'm' })]: 2_500,
    });
    const long: WireCallRequest = {
      ...small,
      messages: [{ role: 'user', content: 'x'.repeat(30_000) }],
    };
    const { delay } = setup({ stats: source });

    expect(delay.for(ctxOf(), small)).toBe(200);
    expect(delay.for(ctxOf(), long)).toBe(2_500);
  });

  it('falls back to the target series for the stream mode when the bucket has no samples', () => {
    const { source, reads } = statsOf({ [key({ provider: 'a', streaming: 'false' })]: 700 });
    const { delay } = setup({ stats: source });

    expect(delay.for(ctxOf(), small)).toBe(700);
    expect(reads.map((read) => read.filter)).toEqual([
      { provider: 'a', streaming: 'false', size: 'xs' },
      { provider: 'a', streaming: 'false' },
    ]);
  });

  it('has no delay without samples, so the call is not hedged', () => {
    const { source } = statsOf({});

    expect(setup({ stats: source }).delay.for(ctxOf(), small)).toBeUndefined();
  });

  it('uses fallbackMs only while there are no samples', () => {
    const { source } = statsOf({ [key({ provider: 'a', streaming: 'false' })]: 700 });
    const { delay } = setup({ stats: source, delay: { quantile: 0.95, fallbackMs: 1_500 } });

    expect(delay.for(ctxOf(), small)).toBe(700);
    expect(delay.for(ctxOf({ streaming: true }), small)).toBe(1_500);
  });

  it('never goes below minMs, learned or not', () => {
    const { source } = statsOf({ [key({ provider: 'a', streaming: 'false' })]: 50 });
    const { delay } = setup({
      stats: source,
      delay: { quantile: 0.95, minMs: 200, fallbackMs: 100 },
    });

    expect(delay.for(ctxOf(), small)).toBe(200);
    expect(delay.for(ctxOf({ streaming: true }), small)).toBe(200);
  });

  it.each([0, -3, Number.NaN, Infinity])('treats a stats value of %s as no data', (value) => {
    const { source } = statsOf({ [key({ provider: 'a', streaming: 'false' })]: value });

    expect(setup({ stats: source }).delay.for(ctxOf(), small)).toBeUndefined();
  });

  it('has no delay when the call has no first target', () => {
    const { source } = statsOf({});

    expect(setup({ stats: source }).delay.for(ctxOf({ targets: [] }), small)).toBeUndefined();
  });

  it('treats a throwing stats source as no data, and warns once', () => {
    const { warnings, delay } = setup({
      stats: {
        quantile: () => {
          throw new Error('stats are down');
        },
      },
    });

    expect(delay.for(ctxOf(), small)).toBeUndefined();
    expect(delay.for(ctxOf(), small)).toBeUndefined();
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain('stats are down');
  });

  it('reports whatever a stats source throws, even when it is not an error', () => {
    const { warnings, delay } = setup({
      stats: {
        quantile: () => {
          throw 'stats are down';
        },
      },
    });

    expect(delay.for(ctxOf(), small)).toBeUndefined();
    expect(warnings()[0]).toContain('stats are down');
  });

  it('still honors fallbackMs when the stats source throws', () => {
    const { delay } = setup({
      stats: {
        quantile: () => {
          throw new Error('stats are down');
        },
      },
      delay: { quantile: 0.95, fallbackMs: 900 },
    });

    expect(delay.for(ctxOf(), small)).toBe(900);
  });
});

describe('reading stats', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
  afterEach(() => vi.useRealTimers());

  it('reuses a read for statsTtlMs', () => {
    const { source, reads } = statsOf({
      [key({ provider: 'a', streaming: 'false', size: 'xs' })]: 5,
    });
    const { delay } = setup({ stats: source, statsTtlMs: 1_000 });

    delay.for(ctxOf(), small);
    delay.for(ctxOf(), small);
    expect(reads).toHaveLength(1);

    vi.setSystemTime(Date.now() + 1_000);
    delay.for(ctxOf(), small);
    expect(reads).toHaveLength(2);
  });

  it('reads every time with a ttl of 0', () => {
    const { source, reads } = statsOf({
      [key({ provider: 'a', streaming: 'false', size: 'xs' })]: 5,
    });
    const { delay } = setup({ stats: source, statsTtlMs: 0 });

    delay.for(ctxOf(), small);
    delay.for(ctxOf(), small);

    expect(reads).toHaveLength(2);
  });

  it('reuses a read that found no samples, so a cold start stays off the hot path', () => {
    const { source, reads } = statsOf({});
    const { delay } = setup({ stats: source });

    delay.for(ctxOf(), small);
    delay.for(ctxOf(), small);

    expect(reads).toHaveLength(2);
  });

  it('does not cache a read that threw', () => {
    let calls = 0;
    const { delay } = setup({
      stats: {
        quantile: () => {
          calls++;
          throw new Error('down');
        },
      },
    });

    delay.for(ctxOf(), small);
    delay.for(ctxOf(), small);

    expect(calls).toBe(2);
  });

  it('keeps reads for different filters apart, whatever the key order', () => {
    const { source, reads } = statsOf({});
    const cache = new StatsCache(source, 1_000);

    cache.quantile({ provider: 'a', streaming: 'false' }, 0.95, 0);
    cache.quantile({ streaming: 'false', provider: 'a' }, 0.95, 0);
    cache.quantile({ provider: 'b', streaming: 'false' }, 0.95, 0);
    cache.quantile({ provider: 'a', streaming: 'false' }, 0.5, 0);

    expect(reads).toHaveLength(3);
  });

  it('stays within its cap however many distinct reads there are', () => {
    const cache = new StatsCache(statsOf({}).source, 1_000);

    for (let index = 0; index < 1_200; index++) cache.quantile({ provider: `p${index}` }, 0.95, 0);

    expect(cache.size).toBeLessThanOrEqual(512);
  });
});

describe('a fixed delay', () => {
  it('is the same for every call and never reads stats', () => {
    const { delay } = setup({ delay: 800 });

    expect(delay.for(ctxOf(), small)).toBe(800);
    expect(delay.for(ctxOf({ targets: [] }), small)).toBe(800);
  });
});

describe('a delay function', () => {
  it('gets the context and the request', () => {
    const fn = vi.fn(() => 250);
    const ctx = ctxOf();
    const { delay } = setup({ delay: fn });

    expect(delay.for(ctx, small)).toBe(250);
    expect(fn).toHaveBeenCalledWith(ctx, small);
  });

  it('skips the call when it returns undefined', () => {
    const { delay, warnings } = setup({ delay: () => undefined });

    expect(delay.for(ctxOf(), small)).toBeUndefined();
    expect(warnings()).toEqual([]);
  });

  it.each([0, -1, Number.NaN, Infinity, '5'])('skips the call for %s, and warns once', (value) => {
    const { delay, warnings } = setup({ delay: () => value as never });

    expect(delay.for(ctxOf(), small)).toBeUndefined();
    expect(delay.for(ctxOf(), small)).toBeUndefined();
    expect(warnings()).toHaveLength(1);
  });

  it('skips the call when it throws, and logs the failure', () => {
    const { delay, errors } = setup({
      delay: () => {
        throw new Error('bad delay');
      },
    });

    expect(delay.for(ctxOf(), small)).toBeUndefined();
    expect(errors()).toHaveLength(1);
  });
});

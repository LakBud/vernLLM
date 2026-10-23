import { describe, expect, it, vi } from 'vitest';

import { StatsCache } from '../../../src/internal/statsCache.js';

describe('StatsCache', () => {
  const source = () => ({
    quantile: vi.fn((_filter: unknown, q: number) => q * 100),
    failureRate: vi.fn(() => 0.25),
  });

  it('reuses a read for the ttl, whatever the filter key order', () => {
    const stats = source();
    const cache = new StatsCache(stats, 1000);

    expect(cache.quantile({ a: '1', b: '2' }, 0.5, 'attemptMs', 0)).toBe(50);
    expect(cache.quantile({ b: '2', a: '1' }, 0.5, 'attemptMs', 999)).toBe(50);
    expect(stats.quantile).toHaveBeenCalledTimes(1);

    cache.quantile({ a: '1', b: '2' }, 0.5, 'attemptMs', 1000);
    expect(stats.quantile).toHaveBeenCalledTimes(2);
  });

  it('keeps reads for different metrics, quantiles and filters apart', () => {
    const stats = source();
    const cache = new StatsCache(stats, 1000);
    cache.quantile({ p: 'a' }, 0.5, 'attemptMs', 0);
    cache.quantile({ p: 'a' }, 0.9, 'attemptMs', 0);
    cache.quantile({ p: 'a' }, 0.5, 'outputTokens', 0);
    cache.quantile({ p: 'b' }, 0.5, 'attemptMs', 0);
    expect(stats.quantile).toHaveBeenCalledTimes(4);
  });

  it('caches an unknown result too, so a quiet target is not re-read every call', () => {
    const stats = { quantile: vi.fn(() => undefined) };
    const cache = new StatsCache(stats, 1000);
    cache.quantile({}, 0.5, 'attemptMs', 0);
    cache.quantile({}, 0.5, 'attemptMs', 10);
    expect(stats.quantile).toHaveBeenCalledTimes(1);
  });

  it('does not cache with a ttl of 0, and rereads when the clock goes backwards', () => {
    const stats = source();
    const cache = new StatsCache(stats, 0);
    cache.quantile({}, 0.5, 'attemptMs', 0);
    cache.quantile({}, 0.5, 'attemptMs', 0);
    expect(stats.quantile).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(0);

    const again = source();
    const second = new StatsCache(again, 1000);
    second.quantile({}, 0.5, 'attemptMs', 5000);
    second.quantile({}, 0.5, 'attemptMs', 4000);
    expect(again.quantile).toHaveBeenCalledTimes(2);
  });

  it('does not cache a read that throws', () => {
    const stats = {
      quantile: vi.fn(() => {
        throw new Error('down');
      }),
    };
    const cache = new StatsCache(stats, 1000);
    expect(() => cache.quantile({}, 0.5, 'attemptMs', 0)).toThrow('down');
    expect(() => cache.quantile({}, 0.5, 'attemptMs', 1)).toThrow('down');
    expect(stats.quantile).toHaveBeenCalledTimes(2);
  });

  it('reads the quality failure rate, and is unknown without failureRate', () => {
    const cache = new StatsCache(source(), 1000);
    expect(cache.failureRate({ provider: 'a' }, 0)).toBe(0.25);
    expect(new StatsCache({ quantile: () => 1 }, 1000).failureRate({}, 0)).toBeUndefined();
  });

  it('caps its size', () => {
    const cache = new StatsCache(source(), 1000);
    for (let i = 0; i < 2000; i++) cache.quantile({ i: String(i) }, 0.5, 'attemptMs', 0);
    expect(cache.size).toBeLessThanOrEqual(512);
  });
});

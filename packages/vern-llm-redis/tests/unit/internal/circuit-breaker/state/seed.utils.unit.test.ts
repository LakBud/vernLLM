import { describe, expect, it, vi } from 'vitest';

import { createLocalCircuitCache } from '../../../../../src/internal/circuit-breaker/state/localCache.utils.js';
import { seedFromScan } from '../../../../../src/internal/circuit-breaker/state/seed.utils.js';
import { fakeRedisClient } from '../../../../helpers.js';

/** What READ_BUCKETS_SCRIPT returns for one open bucket, in the shape parseSnapshotResult reads. */
function openSnapshot(key: string): unknown {
  return [key, 'open', '5', '1234'];
}

describe('seedFromScan', () => {
  it('resolves without touching Redis when the client has no scan', async () => {
    const redis = fakeRedisClient();
    delete (redis as { scan?: unknown }).scan;

    await expect(
      seedFromScan(redis, createLocalCircuitCache(), 'p', () => false),
    ).resolves.toBeUndefined();
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('scans by prefix and seeds an open circuit found elsewhere', async () => {
    const redis = fakeRedisClient();
    const local = createLocalCircuitCache();
    redis.scan.mockResolvedValueOnce(['0', ['p:default']]);
    redis.eval.mockResolvedValueOnce(openSnapshot('p:default'));

    await seedFromScan(redis, local, 'p', () => false);

    expect(redis.scan).toHaveBeenCalledWith('0', 'MATCH', 'p*', 'COUNT', 1000);
    expect(local.get('p:default')).toMatchObject({ state: 'open', failures: 5, openedAt: 1234 });
    expect(local.isPristine('p:default')).toBe(false);
  });

  it("reads only this prefix's own keys, not one under a longer prefix", async () => {
    const redis = fakeRedisClient();
    redis.scan.mockResolvedValueOnce(['0', ['p', 'p:m', 'p2', 'p2:m', 'pa']]);
    redis.eval.mockImplementation(async (_script, _n, key) => openSnapshot(String(key)));

    await seedFromScan(redis, createLocalCircuitCache(), 'p', () => false);

    expect(redis.eval.mock.calls.map((call) => call[2])).toEqual(['p', 'p:m']);
  });

  it('escapes glob characters in the prefix', async () => {
    const redis = fakeRedisClient();

    await seedFromScan(redis, createLocalCircuitCache(), 'app[1]*', () => false);

    expect(redis.scan).toHaveBeenCalledWith('0', 'MATCH', 'app\\[1\\]\\**', 'COUNT', 1000);
  });

  it('follows the cursor across pages until it returns to 0', async () => {
    const redis = fakeRedisClient();
    redis.scan.mockResolvedValueOnce(['7', []]).mockResolvedValueOnce(['0', ['p:a']]);
    redis.eval.mockResolvedValueOnce(openSnapshot('p:a'));

    await seedFromScan(redis, createLocalCircuitCache(), 'p', () => false);

    expect(redis.scan).toHaveBeenCalledTimes(2);
    expect(redis.scan).toHaveBeenLastCalledWith('7', 'MATCH', 'p*', 'COUNT', 1000);
  });

  it('skips a key that has no readable snapshot', async () => {
    const redis = fakeRedisClient();
    const local = createLocalCircuitCache();
    redis.scan.mockResolvedValueOnce(['0', ['p:gone']]);
    redis.eval.mockResolvedValueOnce(null);

    await seedFromScan(redis, local, 'p', () => false);

    expect(local.isPristine('p:gone')).toBe(true);
  });

  it('never overwrites a key this process already heard about, since that is newer than the scan', async () => {
    const redis = fakeRedisClient();
    const local = createLocalCircuitCache();
    local.set('p:default', { ...local.get('p:default'), state: 'closed' });
    redis.scan.mockResolvedValueOnce(['0', ['p:default']]);
    redis.eval.mockResolvedValueOnce(openSnapshot('p:default'));

    await seedFromScan(redis, local, 'p', () => false);

    expect(local.get('p:default').state).toBe('closed');
  });

  it('stops reading keys once disposed', async () => {
    const redis = fakeRedisClient();
    redis.scan.mockResolvedValueOnce(['0', ['p:a', 'p:b']]);
    const isDisposed = vi.fn(() => true);

    await seedFromScan(redis, createLocalCircuitCache(), 'p', isDisposed);

    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('rejects when Redis does, so the caller can report it', async () => {
    const redis = fakeRedisClient();
    redis.scan.mockRejectedValueOnce(new Error('down'));

    await expect(seedFromScan(redis, createLocalCircuitCache(), 'p', () => false)).rejects.toThrow(
      'down',
    );
  });
});

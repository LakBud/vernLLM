import { describe, expect, vi } from 'vitest';

import { fromNodeRedis } from '../../src/clients/nodeRedis.js';
import { withScriptCache } from '../../src/internal/shared/redis/scriptCache.utils.js';
import { it } from '../fixtures.js';
import { connectNodeRedis, uniquePrefix } from '../helpers.js';

const SCRIPT = "return redis.call('INCR', KEYS[1])";

// Concurrent is safe: the NOSCRIPT miss is simulated on this test's own client,
// so nothing here touches the server wide script cache other suites share.
describe.concurrent('withScriptCache, real Redis', () => {
  it('runs through EVALSHA after the first call on ioredis', async ({ redis }) => {
    const key = uniquePrefix('sc');
    const evalsha = vi.spyOn(redis, 'evalsha');
    const cached = withScriptCache(redis);

    expect(await cached.eval(SCRIPT, 1, key)).toBe(1);
    expect(await cached.eval(SCRIPT, 1, key)).toBe(2);
    expect(evalsha).toHaveBeenCalledTimes(1);

    await redis.del(key);
  });

  it('recovers when Redis drops its script cache', async ({ redis }) => {
    const key = uniquePrefix('sc');
    const evalCall = vi.spyOn(redis, 'eval');
    const cached = withScriptCache(redis);

    await cached.eval(SCRIPT, 1, key);
    // The next EVALSHA misses, as if Redis had dropped its script cache.
    vi.spyOn(redis, 'evalsha').mockRejectedValueOnce(
      new Error('NOSCRIPT No matching script. Please use EVAL.'),
    );

    expect(await cached.eval(SCRIPT, 1, key)).toBe(2);
    expect(await cached.eval(SCRIPT, 1, key)).toBe(3);
    expect(evalCall).toHaveBeenCalledTimes(2);

    await redis.del(key);
  });

  it('runs through evalSha on node-redis', async () => {
    const client = await connectNodeRedis();
    const key = uniquePrefix('sc');
    const evalSha = vi.spyOn(client, 'evalSha');
    const cached = withScriptCache(fromNodeRedis(client));

    try {
      expect(await cached.eval(SCRIPT, 1, key)).toBe(1);
      expect(await cached.eval(SCRIPT, 1, key)).toBe(2);
      expect(evalSha).toHaveBeenCalledTimes(1);
    } finally {
      await client.del(key);
      await client.quit();
    }
  });
});

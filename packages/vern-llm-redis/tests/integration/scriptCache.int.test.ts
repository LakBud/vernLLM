import { describe, expect, vi } from 'vitest';

import { fromNodeRedis } from '../../src/clients/nodeRedis.js';
import { withScriptCache } from '../../src/internal/shared/redis/scriptCache.utils.js';
import { it } from '../fixtures.js';
import { connectNodeRedis, uniquePrefix } from '../helpers.js';

const SCRIPT = "return redis.call('INCR', KEYS[1])";

// Not concurrent: SCRIPT FLUSH empties the server wide cache. Other suites
// only ever see a NOSCRIPT they already recover from, but the call counts
// asserted here need this file's own calls to be the only ones in play.
describe('withScriptCache, real Redis', () => {
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
    await redis.script('FLUSH');

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

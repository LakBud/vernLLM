import { VernLLM } from 'vern-llm';
import { bench, describe } from 'vitest';

import { redisCache, type RedisClient } from '../../src/index.js';

// `pnpm bench` for a quick look at the client side cost of the cache. The number CI guards is the
// one from `pnpm bench:check`, which runs against the built package. No network is involved.

function memoryRedis(): RedisClient {
  const data = new Map<string, string>();
  return {
    get: async (key) => data.get(key) ?? null,
    set: async (key, value) => {
      data.set(key, value);
      return 'OK';
    },
    del: async (...keys) => keys.forEach((key) => data.delete(key)),
    eval: async () => [100, 0],
  };
}

const call = { userContent: 'hi', jsonMode: false as const };

describe('the cache with an in memory Redis stand in', () => {
  const llm = new VernLLM({
    client: {
      chat: {
        completions: { create: async () => ({ choices: [{ message: { content: '{}' } }] }) },
      },
    },
    model: 'a-model',
    maxRetries: 0,
    logger: 'silent',
    cache: redisCache(memoryRedis()),
  });
  const hit = { cacheKey: 'k', ttl: 60_000, call };
  let n = 0;

  bench('cache hit', async () => {
    await llm.cachedCall(hit);
  });
  bench('cache miss and store', async () => {
    await llm.cachedCall({ cacheKey: `k${n++}`, ttl: 60_000, call });
  });
});

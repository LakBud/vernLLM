import { describe, expect, it } from 'vitest';

import { redisUsageStore, type RedisUsageStore } from '../../../src/usageStore.js';
import { fakeRedisClient } from '../../helpers.js';

import type { UsageStore } from 'vern-llm-usage';

/** Compile time checks: the shipped store must stay assignable to vern-llm-usage's UsageStore. */
describe('redisUsageStore against vern-llm-usage', () => {
  it('is accepted wherever a UsageStore is, and accepts what a UsageStore does', () => {
    const redisStore: RedisUsageStore = redisUsageStore(fakeRedisClient());
    const asUsageStore: UsageStore = redisStore;
    const backAgain: RedisUsageStore = asUsageStore as RedisUsageStore;

    expect(typeof asUsageStore.reserve).toBe('function');
    expect(backAgain).toBe(redisStore);
  });
});

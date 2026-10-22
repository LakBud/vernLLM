import { LLMError } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { parseFour, parseReserve } from '../../../src/internal/usage-store/scripts.js';
import { redisUsageStore, type UsageScope } from '../../../src/usageStore.js';
import { fakeRedisClient } from '../../helpers.js';

const scope: UsageScope = {
  key: 'k',
  label: 'k per day',
  unit: 'usd',
  limit: 100,
  mode: 'hard',
  resetsAtMs: 1_000_000,
};

describe('redisUsageStore', () => {
  it('passes the scopes as keys, in one slot, and the limits as arguments', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValue([1]);
    const store = redisUsageStore(redis, { keyPrefix: 'app' });

    await store.reserve(
      [scope, { ...scope, key: 'j', unit: 'tokens', limit: 9 }],
      { nanoUsd: 5, tokens: 6 },
      2_500.4,
    );

    const [, numKeys, ...rest] = redis.eval.mock.calls[0]!;
    expect(numKeys).toBe(4);
    expect(rest.slice(0, 4)).toEqual([
      '{app}:exp',
      expect.stringMatching(/^\{app\}:r:/),
      '{app}:s:k',
      '{app}:s:j',
    ]);
    expect(rest.slice(4)).toEqual([
      '{app}:',
      2501,
      86_400_000,
      5,
      6,
      'u',
      100,
      1_000_000,
      't',
      9,
      1_000_000,
    ]);
  });

  it('maps a refusal back to the scope that had no room', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValue([0, 2, 7]);
    const other = { ...scope, key: 'j' };

    await expect(
      redisUsageStore(redis).reserve([scope, other], { nanoUsd: 1, tokens: 0 }, 1000),
    ).resolves.toEqual({ ok: false, scope: other, remaining: 7 });
  });

  it('turns a Redis failure into a connection_failed LLMError', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockRejectedValue(new Error('ECONNRESET'));
    const store = redisUsageStore(redis);

    for (const call of [
      () => store.reserve([scope], { nanoUsd: 1, tokens: 0 }, 1000),
      () => store.commit('id', { nanoUsd: 1, tokens: 0 }),
      () => store.release('id'),
      () => store.read(scope),
    ]) {
      const error = await call().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(LLMError);
      expect(error).toMatchObject({ code: 'connection_failed' });
    }
  });

  it('rejects a reply it cannot read', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValue('nonsense');
    const store = redisUsageStore(redis);

    for (const call of [
      () => store.read(scope),
      () => store.reserve([scope], { nanoUsd: 1, tokens: 0 }, 1),
    ]) {
      const error = await call().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(LLMError);
      expect(error).toMatchObject({ code: 'connection_failed' });
      expect((error as LLMError).message).toContain('Unexpected usage store script reply');
    }
  });

  it('rejects an empty key prefix', () => {
    expect(() => redisUsageStore(fakeRedisClient(), { keyPrefix: '' })).toThrow('keyPrefix');
  });
});

describe('script replies', () => {
  it('parses a grant and a refusal', () => {
    expect(parseReserve([1])).toEqual({ ok: true });
    expect(parseReserve([0, 1, 0])).toEqual({ ok: false, index: 1, remaining: 0 });
  });

  it.each([[[]], [[0]], [[0, 0, 5]], [[0, 1, -1]], [[0, 1, 2, 3]], ['x'], [null]])(
    'rejects %j as a reserve reply',
    (reply) => {
      expect(() => parseReserve(reply)).toThrow('Unexpected usage store script reply');
    },
  );

  it('reads four whole numbers and nothing else', () => {
    expect(parseFour(['1', 2, '3', 4])).toEqual([1, 2, 3, 4]);
    for (const bad of [[1, 2, 3], [1, 2, 3, -1], [1, 2, 3, 1.5], 'x']) {
      expect(() => parseFour(bad)).toThrow('Unexpected usage store script reply');
    }
  });
});

import { VernLLM, type Logger } from 'vern-llm';
import { describe, expect, it, vi } from 'vitest';

import { redisCircuitBreaker } from '../../src/circuitBreaker.js';
import { fromIoredis } from '../../src/clients/ioredis.js';
import { redisRateLimit } from '../../src/rateLimit.js';
import { connect, uniquePrefix, waitUntil } from '../helpers.js';

/** Just enough of an LLM client for VernLLM to construct and run one call. */
function stubClient() {
  return {
    chat: {
      completions: {
        create: async () => ({ choices: [{ message: { content: '{"ok":true}' } }] }),
      },
    },
  } as never;
}

describe('VernLLM hands its logger to the Redis adapters, real Redis', () => {
  it('a Redis failure after a successful call lands in the VernLLM logger, not the console', async () => {
    const redis = connect();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sink: Logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const llm = new VernLLM({
      client: stubClient(),
      model: 'm',
      maxRetries: 0, // these tests are about where a failure is logged, not about retrying it
      logger: sink,
      rateLimit: redisRateLimit(fromIoredis(redis), {
        keyPrefix: uniquePrefix('rl'),
        maxConcurrent: 2,
      }),
      circuitBreaker: redisCircuitBreaker(fromIoredis(redis), {
        keyPrefix: uniquePrefix('cb'),
        pollIntervalMs: 0,
      }),
    });

    await llm.call({ userContent: 'hi' });
    // Redis goes away right after the call succeeded: the release is now
    // a background failure with nobody to throw to.
    vi.spyOn(redis, 'eval').mockRejectedValue(new Error('Redis is down'));
    await llm.call({ userContent: 'again' }).catch(() => {});

    await waitUntil(() => (sink.error as ReturnType<typeof vi.fn>).mock.calls.length > 0);
    expect(sink.error).toHaveBeenCalledWith(
      expect.stringContaining('[VernLLM] redis'),
      expect.objectContaining({ message: 'Redis is down' }),
    );
    expect(consoleSpy).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
    vi.restoreAllMocks();
    await redis.quit();
  });

  it("logger: 'silent' on VernLLM silences the adapters too", async () => {
    const redis = connect();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const llm = new VernLLM({
      client: stubClient(),
      model: 'm',
      maxRetries: 0, // these tests are about where a failure is logged, not about retrying it
      logger: 'silent',
      rateLimit: redisRateLimit(fromIoredis(redis), {
        keyPrefix: uniquePrefix('rl'),
        maxConcurrent: 2,
      }),
    });

    await llm.call({ userContent: 'hi' });
    vi.spyOn(redis, 'eval').mockRejectedValue(new Error('Redis is down'));
    await llm.call({ userContent: 'again' }).catch(() => {});
    await new Promise((r) => setTimeout(r, 100));

    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
    vi.restoreAllMocks();
    await redis.quit();
  });
});

import { describe, expect, it, vi } from 'vitest';

import { redisCircuitBreaker } from '../../../src/circuitBreaker.js';
import { transitionReply, waitFor } from '../../breakerHelpers.js';
import { fakeRedisClient } from '../../helpers.js';

/** A breaker with no background poll, so the only Redis traffic is what the test itself triggers. */
function setup() {
  const redis = fakeRedisClient();
  const onStateChange = vi.fn();
  const breaker = redisCircuitBreaker(redis, { pollIntervalMs: 0, onStateChange });
  return { redis, onStateChange, breaker };
}

describe('redisCircuitBreaker manual open and close', () => {
  it('open sends the open outcome and reports the transition once Redis confirms it', async () => {
    const { redis, onStateChange, breaker } = setup();
    redis.eval.mockResolvedValueOnce(transitionReply('closed', 'open', { failures: 0 }));

    breaker.open?.('m', undefined);

    await waitFor(() => expect(breaker.getState?.('m')).toBe('open'));
    expect(redis.eval.mock.calls[0]![3]).toBe('open');
    expect(onStateChange).toHaveBeenCalledWith('closed', 'open', 0, 'm', undefined);
    breaker.dispose();
  });

  it('close sends the close outcome and reports the transition once Redis confirms it', async () => {
    const { redis, onStateChange, breaker } = setup();
    redis.eval
      .mockResolvedValueOnce(transitionReply('closed', 'open', { failures: 0 }))
      .mockResolvedValueOnce(transitionReply('open', 'closed', { failures: 0 }));

    breaker.open?.('m', undefined);
    await waitFor(() => expect(breaker.getState?.('m')).toBe('open'));
    breaker.close?.('m', undefined);

    await waitFor(() => expect(breaker.getState?.('m')).toBe('closed'));
    expect(redis.eval.mock.calls[1]![3]).toBe('close');
    expect(onStateChange).toHaveBeenLastCalledWith('open', 'closed', 0, 'm', undefined);
    breaker.dispose();
  });

  it('reports a failing manual transition instead of leaving it unhandled', async () => {
    const redis = fakeRedisClient();
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const breaker = redisCircuitBreaker(redis, { pollIntervalMs: 0, logger });
    redis.eval.mockRejectedValueOnce(new Error('down'));

    breaker.open?.('m', undefined);

    await waitFor(() => expect(logger.error).toHaveBeenCalled());
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('open transition failed'),
      expect.objectContaining({ message: 'down' }),
    );
    breaker.dispose();
  });
});

describe('redisCircuitBreaker getFailureBreakdown', () => {
  it('is empty for a key never seen', () => {
    const { breaker } = setup();

    expect(breaker.getFailureBreakdown?.('m')).toEqual({});
    breaker.dispose();
  });

  it('reports the counts Redis last sent, as a copy the caller cannot use to change the cache', async () => {
    const { redis, breaker } = setup();
    const reply = transitionReply('closed', 'open', { failures: 3 });
    reply[6] = 'api=2,timeout=1';
    redis.eval.mockResolvedValueOnce(reply);

    breaker.open?.('m', undefined);
    await waitFor(() => expect(breaker.getState?.('m')).toBe('open'));

    const first = breaker.getFailureBreakdown?.('m');
    expect(first).toEqual({ api: 2, timeout: 1 });

    (first as Record<string, number>).api = 99;
    expect(breaker.getFailureBreakdown?.('m')).toEqual({ api: 2, timeout: 1 });
    breaker.dispose();
  });
});

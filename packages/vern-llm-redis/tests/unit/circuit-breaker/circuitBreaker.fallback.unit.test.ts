import { LLMError } from 'vern-llm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { redisCircuitBreaker } from '../../../src/circuitBreaker.js';
import { callContext, transitionReply, waitFor } from '../../breakerHelpers.js';
import { fakeRedisClient } from '../../helpers.js';

/** A breaker with no background poll, on a client whose scripts fail until told otherwise. */
function downBreaker(options: Parameters<typeof redisCircuitBreaker>[1] = {}) {
  const redis = fakeRedisClient();
  redis.eval.mockRejectedValue(new Error('Redis is down'));
  const breaker = redisCircuitBreaker(redis, { pollIntervalMs: 0, logger: 'silent', ...options });
  return { redis, breaker };
}

/** Lets pending promise callbacks run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('redisCircuitBreaker while Redis is unreachable', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('treats a call still pending after prepareTimeoutMs as Redis being down', () => {
    vi.useFakeTimers();
    const { redis, breaker } = downBreaker({ threshold: 1, prepareTimeoutMs: 100 });
    // A hung connection: nothing ever settles.
    redis.eval.mockReturnValue(new Promise(() => {}));

    breaker.recordFailure('m');
    vi.advanceTimersByTime(99);
    breaker.recordFailure('m');
    expect(breaker.getState?.('m')).toBe('closed');

    // The timer fires at 100ms and checks one event loop turn later.
    vi.advanceTimersByTime(1);
    vi.advanceTimersByTime(1);
    breaker.recordFailure('m');
    expect(breaker.getState?.('m')).toBe('open');
  });

  it('keeps rejecting a state Redis last reported open while a stalled call is pending', async () => {
    vi.useFakeTimers();
    const { redis, breaker } = downBreaker({ threshold: 1, prepareTimeoutMs: 100 });
    redis.eval.mockResolvedValueOnce(
      transitionReply('closed', 'open', { failures: 1, openedAt: 1000 }),
    );

    breaker.recordFailure('m');
    await vi.advanceTimersByTimeAsync(0);
    expect(breaker.getState?.('m')).toBe('open');

    // Hung from here on. The stall timer switches to the local breaker, which starts closed.
    redis.eval.mockReturnValue(new Promise(() => {}));
    breaker.recordFailure('m');
    await vi.advanceTimersByTimeAsync(102);

    expect(() => breaker.assertClosed('m')).toThrow(
      expect.objectContaining({ type: 'circuit_open', code: 'circuit_cooling_down' }),
    );
    expect(breaker.getState?.('m')).toBe('open');
  });

  it('keeps a shared half-open state rejected during a stall, with no local trial', async () => {
    vi.useFakeTimers();
    const onStateChange = vi.fn();
    const { redis, breaker } = downBreaker({ threshold: 1, prepareTimeoutMs: 100, onStateChange });
    redis.eval.mockResolvedValueOnce(
      transitionReply('open', 'half-open', { failures: 1, openedAt: 1000 }),
    );

    breaker.recordFailure('m');
    await vi.advanceTimersByTimeAsync(0);
    expect(breaker.getState?.('m')).toBe('half-open');
    onStateChange.mockClear();

    redis.eval.mockReturnValue(new Promise(() => {}));
    breaker.recordFailure('m');
    await vi.advanceTimersByTimeAsync(102);

    // A fresh local breaker would admit every call here. None may pass, and none may claim a trial.
    for (let i = 0; i < 3; i += 1) {
      expect(() => breaker.assertClosed('m')).toThrow(
        expect.objectContaining({ type: 'circuit_open', code: 'circuit_trial_in_flight' }),
      );
    }
    expect(breaker.getState?.('m')).toBe('half-open');
    expect(onStateChange).not.toHaveBeenCalled();
    const grants = redis.eval.mock.calls.filter((call) => call[3] === 'check' && call[9] === '1');
    expect(grants).toHaveLength(0);
  });

  it('lets a reply read after a blocked event loop win over the stall timer', async () => {
    vi.useFakeTimers();
    const onStateChange = vi.fn();
    const { redis, breaker } = downBreaker({ threshold: 1, prepareTimeoutMs: 100, onStateChange });
    let reply: (value: unknown) => void = () => {};
    redis.eval.mockReturnValueOnce(new Promise((resolve) => (reply = resolve)));
    redis.eval.mockReturnValue(new Promise(() => {}));

    breaker.recordFailure('m');
    // The loop was blocked past the timeout, so the timer fires before the waiting reply is read.
    vi.advanceTimersByTime(100);
    // A call in that gap must not trip a local breaker Redis was never down for.
    breaker.recordFailure('m');
    reply(transitionReply('closed', 'closed', { failures: 0 }));
    await Promise.resolve();
    await Promise.resolve();
    vi.advanceTimersByTime(1);

    expect(onStateChange).not.toHaveBeenCalled();
    expect(breaker.getState?.('m')).toBe('closed');
  });

  it('stays on the shared state when a reply lands before prepareTimeoutMs', async () => {
    vi.useFakeTimers();
    const { redis, breaker } = downBreaker({ threshold: 1, prepareTimeoutMs: 100 });
    redis.eval.mockResolvedValue(transitionReply('closed', 'closed', { failures: 0 }));

    breaker.recordFailure('m');
    await vi.advanceTimersByTimeAsync(500);
    breaker.recordFailure('m');

    // A local breaker at threshold 1 would have opened on that second failure.
    expect(breaker.getState?.('m')).toBe('closed');
  });

  it("trips on core's own breaker after the first failed call, and reports the change", async () => {
    const onStateChange = vi.fn();
    const { breaker } = downBreaker({ threshold: 2, onStateChange });

    // The call that finds Redis down switches to the local breaker; it is not counted there.
    breaker.recordFailure('m');
    await flush();
    expect(breaker.getState?.('m')).toBe('closed');

    breaker.recordFailure('m');
    breaker.recordFailure('m', undefined, 'server_error');

    expect(breaker.getState?.('m')).toBe('open');
    expect(breaker.getFailureBreakdown?.('m')).toEqual({ unknown: 1, server_error: 1 });
    expect(() => breaker.assertClosed('m')).toThrow(
      expect.objectContaining({ type: 'circuit_open', code: 'circuit_cooling_down' }),
    );
    expect(onStateChange).toHaveBeenCalledOnce();
    expect(onStateChange.mock.calls[0]?.slice(0, 3)).toEqual(['closed', 'open', 2]);
  });

  it('goes back to Redis state on the first reply', async () => {
    const { redis, breaker } = downBreaker({ threshold: 1 });
    breaker.recordFailure('m');
    await flush();
    breaker.recordFailure('m');
    expect(breaker.getState?.('m')).toBe('open');

    redis.eval.mockResolvedValue(transitionReply('closed', 'closed', { failures: 0 }));
    // Still decided locally, but the check it sends is what notices Redis is back.
    expect(() => breaker.assertClosed('m')).toThrow(LLMError);

    await waitFor(() => expect(breaker.getState?.('m')).toBe('closed'));
    expect(() => breaker.assertClosed('m')).not.toThrow();
  });

  it('never claims a Redis trial slot while deciding locally', async () => {
    const { redis, breaker } = downBreaker();
    breaker.recordFailure('m');
    await flush();
    redis.eval.mockClear();

    breaker.assertClosed('m');
    await flush();

    // eval(script, numKeys, key, outcome, channel, threshold, cooldown, lease, token, grant, ...)
    const args = redis.eval.mock.calls[0] ?? [];
    expect(args[3]).toBe('check');
    expect(args[9]).toBe('0');
  });

  it('sends manual open, close and trial releases to the local breaker', async () => {
    const { breaker } = downBreaker();
    await expect(breaker.readState?.('m')).rejects.toMatchObject({ type: 'network' });

    breaker.open?.('m');
    expect(breaker.getState?.('m')).toBe('open');
    breaker.close?.('m');
    expect(breaker.getState?.('m')).toBe('closed');
    expect(() => breaker.releaseTrial?.('m', callContext())).not.toThrow();
    expect(() => breaker.releaseTrial?.('m')).not.toThrow();
  });

  it('a successful readState goes back to Redis state', async () => {
    const { redis, breaker } = downBreaker();
    await expect(breaker.readState?.('m')).rejects.toMatchObject({ type: 'network' });
    breaker.open?.('m');
    expect(breaker.getState?.('m')).toBe('open');

    redis.eval.mockResolvedValueOnce(null);
    await expect(breaker.readState?.('m')).resolves.toBe('closed');

    expect(breaker.getState?.('m')).toBe('closed');
  });

  it('builds no local breaker once disposed', async () => {
    const { breaker } = downBreaker();
    breaker.dispose();

    breaker.open?.('m');
    await flush();
    breaker.open?.('m');

    expect(breaker.getState?.('m')).toBe('closed');
  });
});

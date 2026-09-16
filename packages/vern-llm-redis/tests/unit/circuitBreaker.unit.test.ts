import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { redisCircuitBreaker } from '../../src/circuitBreaker.js';
import { fakeRedisClient, fakeSubscriber } from '../helpers.js';

/** Matches TRANSITION_SCRIPT's return shape: [from, to, failuresAsString]. */
function transitionResult(from: string, to: string, failures: number): [string, string, string] {
  return [from, to, String(failures)];
}

describe('redisCircuitBreaker', () => {
  it('assertClosed does not throw while the local cache is closed', () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValue(transitionResult('closed', 'closed', 0));

    const breaker = redisCircuitBreaker(redis);
    expect(() => breaker.assertClosed('gpt-4o')).not.toThrow();
  });

  it('kicks off a background check against Redis on every assertClosed', () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValue(transitionResult('closed', 'closed', 0));

    const breaker = redisCircuitBreaker(redis, { keyPrefix: 'cb' });
    breaker.assertClosed('gpt-4o');

    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('local key = KEYS[1]'),
      1,
      'cb',
      expect.any(Number),
      5,
      30_000,
      'check',
      'cb:events',
    );
  });

  it('recordFailure opens the circuit locally once Redis reports the transition, and fires onStateChange', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValueOnce(transitionResult('closed', 'open', 5));

    const onStateChange = vi.fn();
    const breaker = redisCircuitBreaker(redis, { onStateChange });

    breaker.recordFailure('gpt-4o');
    await vi.waitFor(() => expect(onStateChange).toHaveBeenCalled());

    expect(onStateChange).toHaveBeenCalledWith('closed', 'open', 5, 'gpt-4o', undefined);
  });

  it('does not fire onStateChange when Redis reports no real transition', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValueOnce(transitionResult('closed', 'closed', 1));

    const onStateChange = vi.fn();
    const breaker = redisCircuitBreaker(redis, { onStateChange });

    breaker.recordFailure('gpt-4o');
    await Promise.resolve();
    await Promise.resolve();

    expect(onStateChange).not.toHaveBeenCalled();
  });

  it('assertClosed throws once the local cache has been updated to open', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValueOnce(transitionResult('closed', 'open', 5));

    const onStateChange = vi.fn();
    const breaker = redisCircuitBreaker(redis, { cooldownMs: 30_000, onStateChange });

    breaker.recordFailure('gpt-4o');
    // Wait on the actual signal that the local cache has updated
    // (onStateChange firing), rather than polling assertClosed itself,
    // which would otherwise also kick off its own background 'check'
    // eval calls against an already-exhausted one-shot mock queue.
    await vi.waitFor(() => expect(onStateChange).toHaveBeenCalled());

    try {
      breaker.assertClosed('gpt-4o');
      throw new Error('expected assertClosed to throw');
    } catch (error) {
      expect((error as { type?: string }).type).toBe('circuit_open');
    }
  });

  it('locally transitions open to half-open once the cooldown has elapsed, without throwing', async () => {
    vi.useFakeTimers();
    try {
      const redis = fakeRedisClient();
      redis.eval.mockResolvedValueOnce(transitionResult('closed', 'open', 5));
      redis.eval.mockResolvedValue(transitionResult('half-open', 'half-open', 5));

      const onStateChange = vi.fn();
      const breaker = redisCircuitBreaker(redis, { cooldownMs: 1000, onStateChange });

      breaker.recordFailure('gpt-4o');
      await vi.advanceTimersByTimeAsync(0);

      vi.advanceTimersByTime(1000);

      expect(() => breaker.assertClosed('gpt-4o')).not.toThrow();
      expect(onStateChange).toHaveBeenCalledWith('open', 'half-open', 5, 'gpt-4o', undefined);
    } finally {
      vi.useRealTimers();
    }
  });

  it('isolateByModel uses a per-model key and recovers the model from a pub/sub message', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValue(transitionResult('closed', 'closed', 0));

    const subscriber = fakeSubscriber();
    const onStateChange = vi.fn();

    redisCircuitBreaker(redis, {
      isolateByModel: true,
      keyPrefix: 'cb',
      subscriber,
      onStateChange,
    });

    expect(subscriber.subscribe).toHaveBeenCalledWith('cb:events');

    subscriber.emit('cb:events', 'cb:gpt-4o|open|3|123456');

    expect(onStateChange).toHaveBeenCalledWith('closed', 'open', 3, 'gpt-4o', undefined);
  });

  it('getState defaults to "closed" for a key it has never seen', () => {
    const redis = fakeRedisClient();
    const breaker = redisCircuitBreaker(redis);

    expect(breaker.getState?.('gpt-4o')).toBe('closed');
  });

  it('getState reads the same local cache assertClosed gates against, not a fresh Redis call', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValueOnce(transitionResult('closed', 'open', 5));

    const onStateChange = vi.fn();
    const breaker = redisCircuitBreaker(redis, { onStateChange });

    breaker.recordFailure('gpt-4o');
    await vi.waitFor(() => expect(onStateChange).toHaveBeenCalled());

    expect(breaker.getState?.('gpt-4o')).toBe('open');
  });

  it('getState is isolated per model, same as assertClosed, when isolateByModel is on', () => {
    const redis = fakeRedisClient();
    const breaker = redisCircuitBreaker(redis, { isolateByModel: true });

    expect(breaker.getState?.('gpt-4o')).toBe('closed');
    expect(breaker.getState?.(undefined)).toBe('closed');
  });

  it('a shared (non isolated) bucket reports undefined as the model from a pub/sub message', () => {
    const redis = fakeRedisClient();
    const subscriber = fakeSubscriber();
    const onStateChange = vi.fn();

    redisCircuitBreaker(redis, { keyPrefix: 'cb', subscriber, onStateChange });

    subscriber.emit('cb:events', 'cb|open|3|123456');

    expect(onStateChange).toHaveBeenCalledWith('closed', 'open', 3, undefined, undefined);
  });

  it('ignores a pub/sub message on an unrelated channel', () => {
    const redis = fakeRedisClient();
    const subscriber = fakeSubscriber();
    const onStateChange = vi.fn();

    redisCircuitBreaker(redis, { keyPrefix: 'cb', subscriber, onStateChange });

    subscriber.emit('some:other:channel', 'cb|open|3|123456');

    expect(onStateChange).not.toHaveBeenCalled();
  });

  it('ignores a malformed pub/sub message', () => {
    const redis = fakeRedisClient();
    const subscriber = fakeSubscriber();
    const onStateChange = vi.fn();

    redisCircuitBreaker(redis, { keyPrefix: 'cb', subscriber, onStateChange });

    subscriber.emit('cb:events', '');

    expect(onStateChange).not.toHaveBeenCalled();
  });

  it('defaults onStateChange to a no-op when none is supplied', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValueOnce(transitionResult('closed', 'open', 5));

    const breaker = redisCircuitBreaker(redis);
    expect(() => breaker.recordFailure('gpt-4o')).not.toThrow();
    await vi.waitFor(() => expect(redis.eval).toHaveBeenCalled());
  });

  it('isolateByModel falls back to "default" in the bucket key when model is undefined', () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValue(transitionResult('closed', 'closed', 0));

    const breaker = redisCircuitBreaker(redis, { isolateByModel: true, keyPrefix: 'cb' });
    breaker.assertClosed(undefined);

    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      'cb:default',
      expect.any(Number),
      5,
      30_000,
      'check',
      'cb:events',
    );
  });

  it('a pub/sub message for the "default" bucket key maps back to an undefined model', () => {
    const redis = fakeRedisClient();
    const subscriber = fakeSubscriber();
    const onStateChange = vi.fn();

    redisCircuitBreaker(redis, {
      isolateByModel: true,
      keyPrefix: 'cb',
      subscriber,
      onStateChange,
    });

    subscriber.emit('cb:events', 'cb:default|open|3|123456');

    expect(onStateChange).toHaveBeenCalledWith('closed', 'open', 3, undefined, undefined);
  });

  it('assertClosed names "default" in its error message when the circuit is open for an undefined model', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValueOnce(transitionResult('closed', 'open', 5));

    const onStateChange = vi.fn();
    const breaker = redisCircuitBreaker(redis, { cooldownMs: 30_000, onStateChange });

    breaker.recordFailure(undefined);
    // Wait on the real signal that the local cache updated, not by
    // polling assertClosed itself, same reasoning as the equivalent
    // "gpt-4o" test above: polling would fire its own background
    // 'check' eval calls against an already-exhausted one-shot mock.
    await vi.waitFor(() => expect(onStateChange).toHaveBeenCalled());

    try {
      breaker.assertClosed(undefined);
      throw new Error('expected assertClosed to throw');
    } catch (error) {
      expect((error as Error).message).toBe('Circuit open for default');
    }
  });
});

describe('redisCircuitBreaker background poll (no subscriber)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-checks every key this process has touched on the configured interval', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValue(transitionResult('closed', 'closed', 0));

    const breaker = redisCircuitBreaker(redis, { pollIntervalMs: 1000 });

    breaker.assertClosed('gpt-4o');
    await vi.advanceTimersByTimeAsync(0);
    redis.eval.mockClear();

    await vi.advanceTimersByTimeAsync(1000);

    expect(redis.eval).toHaveBeenCalled();
  });

  it('never schedules a poll when a subscriber is supplied', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValue(transitionResult('closed', 'closed', 0));
    const subscriber = fakeSubscriber();

    const breaker = redisCircuitBreaker(redis, { pollIntervalMs: 1000, subscriber });

    breaker.assertClosed('gpt-4o');
    await vi.advanceTimersByTimeAsync(0);
    redis.eval.mockClear();

    await vi.advanceTimersByTimeAsync(5000);

    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('never schedules a poll when pollIntervalMs is set to 0', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValue(transitionResult('closed', 'closed', 0));

    const breaker = redisCircuitBreaker(redis, { pollIntervalMs: 0 });

    breaker.assertClosed('gpt-4o');
    await vi.advanceTimersByTimeAsync(0);
    redis.eval.mockClear();

    await vi.advanceTimersByTimeAsync(10_000);

    expect(redis.eval).not.toHaveBeenCalled();
  });
});

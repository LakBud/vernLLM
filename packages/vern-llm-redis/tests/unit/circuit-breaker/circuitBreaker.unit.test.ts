import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { redisCircuitBreaker } from '../../../src/circuitBreaker.js';
import { waitFor } from '../../breakerHelpers.js';
import { fakeRedisClient, fakeSubscriber, transitionMessage } from '../../helpers.js';

/** Redis clock and slot state a reply carries alongside the transition itself. */
interface ReplyTiming {
  now?: number;
  cooldown?: number;
  grantAt?: number;
  slots?: number;
}

/** Matches TRANSITION_SCRIPT's return shape: [from, to, failures, wonProbe, openedAt, wonToken, breakdown, now, cooldown, grantAt, slots], all strings. */
function transitionResult(
  from: string,
  to: string,
  failures: number,
  wonProbe = false,
  openedAt = 0,
  wonToken = wonProbe ? '1' : '',
  breakdown = '',
  timing: ReplyTiming = {},
): string[] {
  return [
    from,
    to,
    String(failures),
    wonProbe ? '1' : '0',
    String(openedAt),
    wonToken,
    breakdown,
    String(timing.now ?? 1000),
    String(timing.cooldown ?? 30_000),
    String(timing.grantAt ?? 0),
    String(timing.slots ?? 0),
  ];
}

/**
 * The full ARGV a transition passes, in TRANSITION_SCRIPT's order. Only
 * what a test cares about needs overriding, the rest are core's defaults.
 */
function scriptArgs(
  outcome: string,
  overrides: Partial<Record<'channel' | 'token' | 'grant' | 'code', string>> = {},
) {
  return [
    outcome,
    overrides.channel ?? 'vernllm:cb:events',
    5, // threshold
    30_000, // cooldownMs
    60_000, // probeLeaseMs
    overrides.token ?? '',
    overrides.grant ?? '1',
    1, // halfOpenProbes
    1, // halfOpenSuccessRatio
    0, // backoff multiplier, 0 = off
    0, // backoff maxMs
    expect.any(Number), // jitter
    0, // rolling window, 0 = consecutive tripping
    0,
    0,
    overrides.code ?? '',
  ];
}

/** Matches READ_BUCKETS_SCRIPT's flat return shape: [key, state, failures, openedAt, ...] repeated per non-closed bucket found. */
function readBucketsResult(...buckets: Array<[string, string, number, number]>): string[] {
  return buckets.flatMap(([key, state, failures, openedAt]) => [
    key,
    state,
    String(failures),
    String(openedAt),
  ]);
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
      ...scriptArgs('check', { channel: 'cb:events' }),
    );
  });

  it('recordFailure opens the circuit locally once Redis reports the transition, and fires onStateChange', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValueOnce(transitionResult('closed', 'open', 5));

    const onStateChange = vi.fn();
    const breaker = redisCircuitBreaker(redis, { onStateChange });

    breaker.recordFailure('gpt-4o');
    await waitFor(() => expect(onStateChange).toHaveBeenCalled());

    expect(onStateChange).toHaveBeenCalledWith('closed', 'open', 5, 'gpt-4o', undefined);
  });

  it('recordSuccess closes the circuit locally once Redis reports the transition, and fires onStateChange', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValueOnce(transitionResult('closed', 'open', 5));

    const onStateChange = vi.fn();
    const breaker = redisCircuitBreaker(redis, { onStateChange });

    // Open it first, so this process's local cache is genuinely 'open'
    // (not the fresh-cache default 'closed') before recordSuccess.
    breaker.recordFailure('gpt-4o');
    await waitFor(() =>
      expect(onStateChange).toHaveBeenCalledWith('closed', 'open', 5, 'gpt-4o', undefined),
    );

    redis.eval.mockResolvedValueOnce(transitionResult('open', 'closed', 0));
    breaker.recordSuccess('gpt-4o');
    await waitFor(() =>
      expect(onStateChange).toHaveBeenCalledWith('open', 'closed', 0, 'gpt-4o', undefined),
    );
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
    const breaker = redisCircuitBreaker(redis, {
      logger: 'silent',
      cooldownMs: 30_000,
      onStateChange,
    });

    breaker.recordFailure('gpt-4o');
    // Wait on the actual signal that the local cache has updated
    // (onStateChange firing), rather than polling assertClosed itself,
    // which would otherwise also kick off its own background 'check'
    // eval calls against an already-exhausted one-shot mock queue.
    await waitFor(() => expect(onStateChange).toHaveBeenCalled());

    try {
      breaker.assertClosed('gpt-4o');
      throw new Error('expected assertClosed to throw');
    } catch (error) {
      expect((error as { type?: string }).type).toBe('circuit_open');
    }
  });

  it('the first assertClosed after cooldown still throws (nothing confirmed yet), but wins the trial for the next one', async () => {
    vi.useFakeTimers();
    try {
      const redis = fakeRedisClient();
      redis.eval.mockResolvedValueOnce(transitionResult('closed', 'open', 5));
      // The 'check' call assertClosed kicks off in the background: this
      // is what actually confirms the open->half-open transition and
      // wins the trial, but it resolves asynchronously, after that
      // first call has already synchronously thrown.
      redis.eval.mockResolvedValue(transitionResult('open', 'half-open', 5, true));

      const onStateChange = vi.fn();
      const breaker = redisCircuitBreaker(redis, { cooldownMs: 1000, onStateChange });

      breaker.recordFailure('gpt-4o');
      await vi.advanceTimersByTimeAsync(0);

      vi.advanceTimersByTime(1000);

      // Cooldown looks elapsed by the local clock, but nothing has
      // confirmed that with Redis yet: this call still throws, and only
      // schedules the confirming check in the background.
      expect(() => breaker.assertClosed('gpt-4o')).toThrow();
      await vi.advanceTimersByTimeAsync(0);

      expect(onStateChange).toHaveBeenCalledWith('open', 'half-open', 5, 'gpt-4o', undefined);

      // Now that Redis has confirmed this process won the trial, the
      // next call is finally let through.
      expect(() => breaker.assertClosed('gpt-4o')).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a repeat check call that cannot win the lease again preserves an already-held, unconsumed trial', async () => {
    vi.useFakeTimers();
    try {
      const redis = fakeRedisClient();
      redis.eval.mockResolvedValueOnce(transitionResult('closed', 'open', 5));
      // This process wins the trial on the first confirming check.
      redis.eval.mockResolvedValueOnce(transitionResult('open', 'half-open', 5, true));

      const breaker = redisCircuitBreaker(redis, {
        logger: 'silent',
        cooldownMs: 1000,
        pollIntervalMs: 500,
      });

      breaker.recordFailure('gpt-4o');
      await vi.advanceTimersByTimeAsync(0);

      vi.advanceTimersByTime(1000);
      expect(() => breaker.assertClosed('gpt-4o')).toThrow();
      await vi.advanceTimersByTimeAsync(0);

      // A later repeat 'check' (from the background poll here) can't win
      // the lease a second time, wonProbe is false, but the bucket is
      // still half-open: the trial this process already won must not be
      // wiped out by that repeat confirmation.
      redis.eval.mockResolvedValue(transitionResult('half-open', 'half-open', 5, false));
      await vi.advanceTimersByTimeAsync(500);

      expect(() => breaker.assertClosed('gpt-4o')).not.toThrow();
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

    subscriber.emit(
      'cb:events',
      transitionMessage({ key: 'cb:gpt-4o', state: 'open', failures: 3, openedAt: 123456 }),
    );

    expect(onStateChange).toHaveBeenCalledWith('closed', 'open', 3, 'gpt-4o', undefined);
  });

  it("a pub/sub half-open message does not grant a trial by itself, only this process's own wonProbe result can", () => {
    const redis = fakeRedisClient();
    const subscriber = fakeSubscriber();

    const breaker = redisCircuitBreaker(redis, {
      logger: 'silent',
      isolateByModel: true,
      keyPrefix: 'cb',
      subscriber,
    });

    subscriber.emit(
      'cb:events',
      transitionMessage({ key: 'cb:gpt-4o', state: 'half-open', failures: 5, openedAt: 123456 }),
    );

    // Observed via pub/sub only, never through this process's own
    // wonProbe confirmation: no trial is available here.
    expect(() => breaker.assertClosed('gpt-4o')).toThrow();
  });

  it('getState defaults to "closed" for a key it has never seen', () => {
    const redis = fakeRedisClient();
    const breaker = redisCircuitBreaker(redis);

    expect(breaker.getState?.('gpt-4o')).toBe('closed');
  });

  describe('startup snapshot', () => {
    it('picks up a circuit another process already opened in Redis, before this process makes any call', async () => {
      const redis = fakeRedisClient();
      redis.scan.mockResolvedValueOnce(['0', ['vernllm:cb']]);
      redis.eval.mockResolvedValueOnce(readBucketsResult(['vernllm:cb', 'open', 5, 1000]));

      const breaker = redisCircuitBreaker(redis, { logger: 'silent' });
      // Let the fire-and-forget snapshot resolve before asserting.
      await waitFor(() => expect(breaker.getState?.()).toBe('open'));

      expect(() => breaker.assertClosed()).toThrow();
    });

    it('confirms every isolateByModel key the snapshot finds, leaving keys Redis never mentioned at their optimistic default', async () => {
      const redis = fakeRedisClient();
      redis.scan.mockResolvedValueOnce(['0', ['cb:gpt-4o']]);
      redis.eval.mockResolvedValueOnce(readBucketsResult(['cb:gpt-4o', 'open', 5, 1000]));

      const breaker = redisCircuitBreaker(redis, {
        logger: 'silent',
        isolateByModel: true,
        keyPrefix: 'cb',
      });
      await waitFor(() => expect(breaker.getState?.('gpt-4o')).toBe('open'));

      expect(() => breaker.assertClosed('gpt-4o')).toThrow();
      // 'claude' was never returned by the snapshot (Redis has no key
      // for it, meaning it's genuinely closed), so it keeps the same
      // optimistic default an adapter with no snapshot at all would use.
      expect(() => breaker.assertClosed('claude')).not.toThrow();
    });

    it('follows a paginated scan across more than one cursor page', async () => {
      const redis = fakeRedisClient();
      redis.scan.mockResolvedValueOnce(['17', ['cb:a']]).mockResolvedValueOnce(['0', ['cb:b']]);
      redis.eval
        .mockResolvedValueOnce(readBucketsResult(['cb:a', 'open', 1, 1000]))
        .mockResolvedValueOnce(readBucketsResult(['cb:b', 'open', 1, 1000]));

      const breaker = redisCircuitBreaker(redis, { isolateByModel: true, keyPrefix: 'cb' });
      await waitFor(() => expect(breaker.getState?.('a')).toBe('open'));
      await waitFor(() => expect(breaker.getState?.('b')).toBe('open'));

      expect(redis.scan).toHaveBeenCalledTimes(2);
    });

    it('skips a page with no matched keys without an extra eval call', async () => {
      const redis = fakeRedisClient();
      redis.scan.mockResolvedValueOnce(['0', []]);

      redisCircuitBreaker(redis);
      await Promise.resolve();
      await Promise.resolve();

      expect(redis.eval).not.toHaveBeenCalled();
    });

    it('does nothing when the given RedisClient has no scan method', async () => {
      const redis = fakeRedisClient();
      // @ts-expect-error exercising a client that omits the optional method
      redis.scan = undefined;

      redisCircuitBreaker(redis);
      await Promise.resolve();
      await Promise.resolve();

      expect(redis.eval).not.toHaveBeenCalled();
    });

    it('reports, instead of leaving unhandled, a scan that rejects', async () => {
      const redis = fakeRedisClient();
      redis.scan.mockRejectedValueOnce(new Error('redis down'));
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      redisCircuitBreaker(redis);
      await Promise.resolve();
      await Promise.resolve();

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('snapshot'),
        expect.objectContaining({ message: expect.any(String) }),
      );
      consoleErrorSpy.mockRestore();
    });

    it('reports, instead of leaving unhandled, a bucket-read eval that rejects', async () => {
      const redis = fakeRedisClient();
      redis.scan.mockResolvedValueOnce(['0', ['vernllm:cb']]);
      redis.eval.mockRejectedValueOnce(new Error('redis down'));
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      redisCircuitBreaker(redis);
      await waitFor(() =>
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          expect.stringContaining('snapshot'),
          expect.objectContaining({ message: expect.any(String) }),
        ),
      );

      consoleErrorSpy.mockRestore();
    });
  });

  it('getState reads the same local cache assertClosed gates against, not a fresh Redis call', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValueOnce(transitionResult('closed', 'open', 5));

    const onStateChange = vi.fn();
    const breaker = redisCircuitBreaker(redis, { onStateChange });

    breaker.recordFailure('gpt-4o');
    await waitFor(() => expect(onStateChange).toHaveBeenCalled());

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

    subscriber.emit(
      'cb:events',
      transitionMessage({ key: 'cb', state: 'open', failures: 3, openedAt: 123456 }),
    );

    expect(onStateChange).toHaveBeenCalledWith('closed', 'open', 3, undefined, undefined);
  });

  it('ignores a pub/sub message on an unrelated channel', () => {
    const redis = fakeRedisClient();
    const subscriber = fakeSubscriber();
    const onStateChange = vi.fn();

    redisCircuitBreaker(redis, { keyPrefix: 'cb', subscriber, onStateChange });

    subscriber.emit(
      'some:other:channel',
      transitionMessage({ key: 'cb', state: 'open', failures: 3, openedAt: 123456 }),
    );

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
    await waitFor(() => expect(redis.eval).toHaveBeenCalled());
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
      ...scriptArgs('check', { channel: 'cb:events' }),
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

    subscriber.emit(
      'cb:events',
      transitionMessage({ key: 'cb:default', state: 'open', failures: 3, openedAt: 123456 }),
    );

    expect(onStateChange).toHaveBeenCalledWith('closed', 'open', 3, undefined, undefined);
  });

  it('assertClosed names "default" in its error message when the circuit is open for an undefined model', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValueOnce(transitionResult('closed', 'open', 5));

    const onStateChange = vi.fn();
    const breaker = redisCircuitBreaker(redis, {
      logger: 'silent',
      cooldownMs: 30_000,
      onStateChange,
    });

    breaker.recordFailure(undefined);
    // Wait on the real signal that the local cache updated, not by
    // polling assertClosed itself, same reasoning as the equivalent
    // "gpt-4o" test above: polling would fire its own background
    // 'check' eval calls against an already-exhausted one-shot mock.
    await waitFor(() => expect(onStateChange).toHaveBeenCalled());

    try {
      breaker.assertClosed(undefined);
      throw new Error('expected assertClosed to throw');
    } catch (error) {
      expect((error as Error).message).toBe('Circuit open for default');
    }
  });

  it('assertClosed uses the half-open specific message when the circuit is half-open but no trial is available', async () => {
    vi.useFakeTimers();
    try {
      const redis = fakeRedisClient();
      redis.eval.mockResolvedValueOnce(transitionResult('closed', 'open', 5));
      redis.eval.mockResolvedValueOnce(transitionResult('open', 'half-open', 5, true));

      const breaker = redisCircuitBreaker(redis, { logger: 'silent', cooldownMs: 1000 });

      breaker.recordFailure('gpt-4o');
      await vi.advanceTimersByTimeAsync(0);

      vi.advanceTimersByTime(1000);
      // Nothing confirmed yet: throws, and kicks off the confirming
      // check that wins the trial in the background.
      expect(() => breaker.assertClosed('gpt-4o')).toThrow();
      await vi.advanceTimersByTimeAsync(0);

      // Trial won and available: this call consumes it.
      expect(() => breaker.assertClosed('gpt-4o')).not.toThrow();

      // The trial is now consumed: this next call is genuinely
      // half-open with no trial available, not merely open.
      try {
        breaker.assertClosed('gpt-4o');
        throw new Error('expected assertClosed to throw');
      } catch (error) {
        expect((error as Error).message).toBe('Circuit half-open, no trial available for gpt-4o');
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('assertClosed names "default" in the half-open message too, when the circuit is half-open with no trial for an undefined model', async () => {
    vi.useFakeTimers();
    try {
      const redis = fakeRedisClient();
      redis.eval.mockResolvedValueOnce(transitionResult('closed', 'open', 5));
      redis.eval.mockResolvedValueOnce(transitionResult('open', 'half-open', 5, true));

      const breaker = redisCircuitBreaker(redis, { logger: 'silent', cooldownMs: 1000 });

      breaker.recordFailure(undefined);
      await vi.advanceTimersByTimeAsync(0);

      vi.advanceTimersByTime(1000);
      expect(() => breaker.assertClosed(undefined)).toThrow();
      await vi.advanceTimersByTimeAsync(0);

      expect(() => breaker.assertClosed(undefined)).not.toThrow();

      try {
        breaker.assertClosed(undefined);
        throw new Error('expected assertClosed to throw');
      } catch (error) {
        expect((error as Error).message).toBe('Circuit half-open, no trial available for default');
      }
    } finally {
      vi.useRealTimers();
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

  it('reports, instead of leaving unhandled, a poll transition that rejects', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValueOnce(transitionResult('closed', 'closed', 0));

    const breaker = redisCircuitBreaker(redis, { pollIntervalMs: 1000 });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    breaker.assertClosed('gpt-4o');
    await vi.advanceTimersByTimeAsync(0);

    redis.eval.mockRejectedValueOnce(new Error('redis down'));
    await vi.advanceTimersByTimeAsync(1000);
    // Flush the rejected promise's microtask before asserting.
    await vi.advanceTimersByTimeAsync(0);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('poll transition'),
      expect.objectContaining({ message: expect.any(String) }),
    );
    consoleErrorSpy.mockRestore();
  });
});

describe('redisCircuitBreaker rejection reporting', () => {
  it('reports, instead of leaving unhandled, a subscriber.subscribe() that rejects', async () => {
    const redis = fakeRedisClient();
    const subscriber = fakeSubscriber();
    subscriber.subscribe.mockRejectedValueOnce(new Error('subscribe failed'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    redisCircuitBreaker(redis, { subscriber });
    // Let the rejected subscribe() promise's .catch() run.
    await Promise.resolve();
    await Promise.resolve();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('subscribe'),
      expect.objectContaining({ message: expect.any(String) }),
    );
    consoleErrorSpy.mockRestore();
  });

  it('falls back to polling when the subscriber fails to subscribe, instead of leaving an idle key unconverged', async () => {
    vi.useFakeTimers();
    try {
      const redis = fakeRedisClient();
      const subscriber = fakeSubscriber();
      subscriber.subscribe.mockRejectedValueOnce(new Error('subscribe failed'));
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // First eval is assertClosed's own background 'check' call, which
      // also seeds local.keys() with this key so the poll timer has
      // something to re-check.
      redis.eval.mockResolvedValueOnce(transitionResult('closed', 'closed', 0));
      const breaker = redisCircuitBreaker(redis, { subscriber, pollIntervalMs: 1000 });
      breaker.assertClosed('gpt-4o');

      // Let the rejected subscribe() promise's .catch() run and start polling.
      await vi.advanceTimersByTimeAsync(0);

      redis.eval.mockResolvedValueOnce(transitionResult('closed', 'open', 5));
      await vi.advanceTimersByTimeAsync(1000);

      expect(redis.eval).toHaveBeenCalledTimes(2);
      consoleErrorSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports, instead of leaving unhandled, a recordSuccess transition that rejects', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockRejectedValueOnce(new Error('redis down'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const breaker = redisCircuitBreaker(redis);
    breaker.recordSuccess('gpt-4o');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('recordSuccess'),
      expect.objectContaining({ message: expect.any(String) }),
    );
    consoleErrorSpy.mockRestore();
  });

  it('reports, instead of leaving unhandled, a recordFailure transition that rejects', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockRejectedValueOnce(new Error('redis down'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const breaker = redisCircuitBreaker(redis);
    breaker.recordFailure('gpt-4o');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('recordFailure'),
      expect.objectContaining({ message: expect.any(String) }),
    );
    consoleErrorSpy.mockRestore();
  });
});

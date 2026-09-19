import { afterEach, describe, expect, it, vi } from 'vitest';

import { redisCircuitBreaker } from '../../../src/circuitBreaker.js';
import { callContext, waitFor } from '../../breakerHelpers.js';
import { fakeRedisClient, fakeSubscriber, transitionMessage } from '../../helpers.js';

function result(
  from: string,
  to: string,
  failures = 0,
  wonProbe = false,
  token = wonProbe ? '7' : '',
): string[] {
  return [
    from,
    to,
    String(failures),
    wonProbe ? '1' : '0',
    '0',
    token,
    '',
    '1000',
    '30000',
    '0',
    '0',
  ];
}

/**
 * eval() argument positions. The script, numKeys and key come first, so
 * TRANSITION_SCRIPT's ARGV[n] (1 based, see its doc comment) is at 2 + n.
 */
const OUTCOME_ARG = 3; // ARGV[1]
const TOKEN_ARG = 8; // ARGV[6]
const GRANT_ARG = 9; // ARGV[7]
const CODE_ARG = 18; // ARGV[16]

function callsFor(redis: ReturnType<typeof fakeRedisClient>, outcome: string) {
  return redis.eval.mock.calls.filter((call) => call[OUTCOME_ARG] === outcome);
}

describe('redisCircuitBreaker trial tokens', () => {
  it("a call that won the half-open slot presents that slot's token on its outcome", async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValue(result('open', 'half-open', 1, true, '7'));
    const breaker = redisCircuitBreaker(redis, { pollIntervalMs: 0 });

    // A first call so the local cache learns it won the slot.
    breaker.assertClosed('m');
    await waitFor(() => expect(breaker.getState?.('m')).toBe('half-open'));

    const c = callContext();
    breaker.assertClosed('m', c);
    breaker.recordSuccess('m', c);

    await waitFor(() => expect(callsFor(redis, 'success')).toHaveLength(1));
    expect(callsFor(redis, 'success')[0]![TOKEN_ARG]).toBe('7');
  });

  it('a call with a context but no slot presents no token, so it cannot settle a trial', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValue(result('closed', 'closed'));
    const breaker = redisCircuitBreaker(redis, { pollIntervalMs: 0 });

    breaker.recordSuccess('m', callContext());

    await waitFor(() => expect(callsFor(redis, 'success')).toHaveLength(1));
    expect(callsFor(redis, 'success')[0]![TOKEN_ARG]).toBe('');
  });

  it('a call with no context at all always counts, matching core', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValue(result('closed', 'closed'));
    const breaker = redisCircuitBreaker(redis, { pollIntervalMs: 0 });

    breaker.recordFailure('m');

    await waitFor(() => expect(callsFor(redis, 'failure')).toHaveLength(1));
    expect(callsFor(redis, 'failure')[0]![TOKEN_ARG]).toBe('*');
  });

  it('forwards the failure code so Redis can attribute it', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValue(result('closed', 'closed', 1));
    const breaker = redisCircuitBreaker(redis, { pollIntervalMs: 0 });

    breaker.recordFailure('m', undefined, 'request_timeout');

    await waitFor(() => expect(callsFor(redis, 'failure')).toHaveLength(1));
    expect(callsFor(redis, 'failure')[0]![CODE_ARG]).toBe('request_timeout');
  });

  it('a permit is spent by its outcome, so a second outcome for the same call is stale', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValue(result('open', 'half-open', 1, true, '7'));
    const breaker = redisCircuitBreaker(redis, { pollIntervalMs: 0 });

    breaker.assertClosed('m');
    await waitFor(() => expect(breaker.getState?.('m')).toBe('half-open'));

    const c = callContext();
    breaker.assertClosed('m', c);
    breaker.recordSuccess('m', c);
    breaker.recordSuccess('m', c);

    await waitFor(() => expect(callsFor(redis, 'success')).toHaveLength(2));
    expect(callsFor(redis, 'success').map((call) => call[TOKEN_ARG])).toEqual(['7', '']);
  });

  it('releaseTrial does nothing, not even a Redis call, for a call that held no slot', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValue(result('closed', 'closed'));
    const breaker = redisCircuitBreaker(redis, { pollIntervalMs: 0 });

    breaker.releaseTrial?.('m', callContext());
    breaker.releaseTrial?.('m', undefined);
    await Promise.resolve();

    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('releaseTrial gives the slot back once, then asks for one again', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValue(result('open', 'half-open', 1, true, '7'));
    const breaker = redisCircuitBreaker(redis, { pollIntervalMs: 0 });

    breaker.assertClosed('m');
    await waitFor(() => expect(breaker.getState?.('m')).toBe('half-open'));

    const c = callContext();
    breaker.assertClosed('m', c);
    redis.eval.mockClear();

    breaker.releaseTrial?.('m', c);
    breaker.releaseTrial?.('m', c);

    await waitFor(() => expect(callsFor(redis, 'release')).toHaveLength(1));
    await waitFor(() => expect(callsFor(redis, 'check')).toHaveLength(1));
    expect(callsFor(redis, 'release')[0]![TOKEN_ARG]).toBe('7');
  });
});

describe('redisCircuitBreaker rejection errors', () => {
  it('an open circuit rejects with the same code core uses while cooling down', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValue(result('closed', 'open', 5));
    const breaker = redisCircuitBreaker(redis, { pollIntervalMs: 0 });

    breaker.recordFailure('m');
    await waitFor(() => expect(breaker.getState?.('m')).toBe('open'));

    expect(() => breaker.assertClosed('m')).toThrowError(
      expect.objectContaining({ type: 'circuit_open', code: 'circuit_cooling_down' }),
    );
  });

  it("a half-open circuit with no slot rejects with core's trial in flight code", async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValue(result('open', 'half-open', 5));
    const breaker = redisCircuitBreaker(redis, { pollIntervalMs: 0 });

    breaker.assertClosed('m');
    await waitFor(() => expect(breaker.getState?.('m')).toBe('half-open'));

    expect(() => breaker.assertClosed('m')).toThrowError(
      expect.objectContaining({ type: 'circuit_open', code: 'circuit_trial_in_flight' }),
    );
  });
});

describe('redisCircuitBreaker option validation', () => {
  const redis = () => fakeRedisClient();

  it('rejects cooldownBackoff given as a function, which cannot run inside Redis', () => {
    expect(() =>
      redisCircuitBreaker(redis(), { cooldownBackoff: (() => 1) as never }),
    ).toThrowError(/function is not supported/);
  });

  it('rejects a custom TrippingPolicy, which cannot run inside Redis', () => {
    expect(() =>
      redisCircuitBreaker(redis(), {
        tripping: { onSuccess() {}, onFailure: () => true, reset() {} } as never,
      }),
    ).toThrowError(/cannot run inside Redis/);
  });

  it('validates rolling tripping like core does, as RangeErrors', () => {
    const rolling = (patch: object) =>
      redisCircuitBreaker(redis(), {
        tripping: { kind: 'rolling', windowMs: 1000, minCalls: 1, failureRatio: 0.5, ...patch },
      });

    expect(() => rolling({ windowMs: 0 })).toThrow(RangeError);
    expect(() => rolling({ minCalls: -1 })).toThrow(RangeError);
    expect(() => rolling({ minCalls: 1.5 })).toThrow(RangeError);
    expect(() => rolling({ failureRatio: 2 })).toThrow(RangeError);
    expect(() => rolling({})).not.toThrow();
  });

  it('rejects a non positive backoff multiplier and probe lease', () => {
    expect(() => redisCircuitBreaker(redis(), { cooldownBackoff: { multiplier: 0 } })).toThrowError(
      /multiplier/,
    );
    expect(() => redisCircuitBreaker(redis(), { probeLeaseMs: 0 })).toThrowError(/probeLeaseMs/);
  });

  it('clamps halfOpenProbes and halfOpenSuccessRatio instead of throwing, like core', async () => {
    const r = redis();
    r.eval.mockResolvedValue(result('closed', 'closed'));
    const breaker = redisCircuitBreaker(r, {
      pollIntervalMs: 0,
      halfOpenProbes: -3,
      halfOpenSuccessRatio: 9,
    });

    breaker.assertClosed('m');
    await waitFor(() => expect(r.eval).toHaveBeenCalled());

    const args = r.eval.mock.calls[0]!;
    expect(args[3 + 7]).toBe(1); // probes clamped to 1
    expect(args[3 + 8]).toBe(1); // ratio clamped to 1
  });
});

describe('redisCircuitBreaker background poll grants', () => {
  afterEach(() => vi.useRealTimers());

  it('a poll only asks for a trial slot when this process has been calling recently', async () => {
    vi.useFakeTimers();
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValue(result('closed', 'closed'));
    const breaker = redisCircuitBreaker(redis, { pollIntervalMs: 100 });

    breaker.assertClosed('m'); // demand now
    await vi.advanceTimersByTimeAsync(100);
    const busy = callsFor(redis, 'check').at(-1)!;
    expect(busy[GRANT_ARG]).toBe('1');

    // Long idle: well past 2x the interval since the last call.
    await vi.advanceTimersByTimeAsync(1000);
    const idle = callsFor(redis, 'check').at(-1)!;
    expect(idle[GRANT_ARG]).toBe('0');

    breaker.dispose();
  });
});

describe('redisCircuitBreaker dispose', () => {
  afterEach(() => vi.useRealTimers());

  it('stops the poll timer and swallows failures from a closing client', async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValue(result('closed', 'closed'));
    const breaker = redisCircuitBreaker(redis, { pollIntervalMs: 100 });

    breaker.assertClosed('m');
    await vi.advanceTimersByTimeAsync(100);
    const callsBefore = redis.eval.mock.calls.length;

    breaker.dispose();
    redis.eval.mockRejectedValue(new Error('Connection is closed.'));
    await vi.advanceTimersByTimeAsync(1000);

    expect(redis.eval.mock.calls.length).toBe(callsBefore);

    breaker.recordFailure('m'); // a late call against a closed client
    await vi.advanceTimersByTimeAsync(10);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('unsubscribes and ignores later pub/sub messages, and is idempotent', async () => {
    const redis = fakeRedisClient();
    const subscriber = fakeSubscriber();
    const unsubscribe = vi.fn(async () => undefined);
    Object.assign(subscriber, { unsubscribe });
    const onStateChange = vi.fn();
    const breaker = redisCircuitBreaker(redis, { subscriber, keyPrefix: 'cb', onStateChange });

    breaker.dispose();
    breaker.dispose();
    subscriber.emit(
      'cb:events',
      transitionMessage({ key: 'cb', state: 'open', failures: 5, openedAt: 1 }),
    );

    expect(unsubscribe).toHaveBeenCalledWith('cb:events');
    expect(onStateChange).not.toHaveBeenCalled();
  });
});

describe('redisCircuitBreaker startup seeding race', () => {
  it('a snapshot read earlier never overwrites what this process learned since', async () => {
    const redis = fakeRedisClient();
    const subscriber = fakeSubscriber();

    // Snapshot says "open", but only resolves after a live message says "closed".
    let releaseSnapshot!: (value: unknown) => void;
    redis.scan.mockResolvedValueOnce(['0', ['cb']]);
    redis.eval.mockImplementation(() => new Promise((resolve) => (releaseSnapshot = resolve)));

    const breaker = redisCircuitBreaker(redis, { subscriber, keyPrefix: 'cb' });
    await waitFor(() => expect(redis.eval).toHaveBeenCalled());

    subscriber.emit(
      'cb:events',
      transitionMessage({ key: 'cb', state: 'closed', failures: 0, openedAt: 0 }),
    );
    releaseSnapshot(['cb', 'open', '5', '123']);
    await new Promise((r) => setTimeout(r, 20));

    expect(breaker.getState?.()).toBe('closed');
  });

  it('still seeds a key this process has never heard about', async () => {
    const redis = fakeRedisClient();
    redis.scan.mockResolvedValueOnce(['0', ['cb']]);
    redis.eval.mockResolvedValue(['cb', 'open', '5', '123']);

    const breaker = redisCircuitBreaker(redis, { keyPrefix: 'cb', pollIntervalMs: 0 });

    await waitFor(() => expect(breaker.getState?.()).toBe('open'));
  });
});

describe('redisCircuitBreaker remaining validation', () => {
  it.each([-1, Number.NaN, Infinity])('rejects cooldownMs %s', (value) => {
    expect(() => redisCircuitBreaker(fakeRedisClient(), { cooldownMs: value })).toThrowError(
      /cooldownMs/,
    );
  });

  it.each([-1, Number.NaN])('rejects pollIntervalMs %s', (value) => {
    expect(() => redisCircuitBreaker(fakeRedisClient(), { pollIntervalMs: value })).toThrowError(
      /pollIntervalMs/,
    );
  });

  it.each([0, -5, Number.NaN])('rejects cooldownBackoff.maxMs %s', (maxMs) => {
    expect(() =>
      redisCircuitBreaker(fakeRedisClient(), { cooldownBackoff: { multiplier: 2, maxMs } }),
    ).toThrowError(/maxMs/);
  });

  it('accepts a valid cooldownBackoff', () => {
    expect(() =>
      redisCircuitBreaker(fakeRedisClient(), {
        cooldownBackoff: { multiplier: 2, maxMs: 60_000 },
        pollIntervalMs: 0,
      }),
    ).not.toThrow();
  });
});

describe('redisCircuitBreaker startup scan edge cases', () => {
  it('stops seeding once disposed mid scan, without reading the remaining keys', async () => {
    const redis = fakeRedisClient();
    redis.scan.mockResolvedValueOnce(['0', ['cb:a', 'cb:b']]);
    let finishFirst!: (value: unknown) => void;
    redis.eval.mockImplementationOnce(() => new Promise((resolve) => (finishFirst = resolve)));

    const breaker = redisCircuitBreaker(redis, { keyPrefix: 'cb', pollIntervalMs: 0 });
    await waitFor(() => expect(redis.eval).toHaveBeenCalledTimes(1));

    breaker.dispose();
    finishFirst(['cb:a', 'open', '5', '1']);
    await new Promise((r) => setTimeout(r, 20));

    expect(redis.eval).toHaveBeenCalledTimes(1);
    expect(breaker.getState?.('a')).not.toBe('open');
  });

  it('skips a key that vanished between the scan and the read', async () => {
    const redis = fakeRedisClient();
    redis.scan.mockResolvedValueOnce(['0', ['cb:gone', 'cb']]);
    redis.eval.mockResolvedValueOnce(null).mockResolvedValueOnce(['cb', 'open', '5', '123']);

    const breaker = redisCircuitBreaker(redis, { keyPrefix: 'cb', pollIntervalMs: 0 });

    await waitFor(() => expect(breaker.getState?.()).toBe('open'));
    expect(redis.eval).toHaveBeenCalledTimes(2);
  });

  it('dispose swallows a failing unsubscribe', async () => {
    const subscriber = fakeSubscriber();
    Object.assign(subscriber, { unsubscribe: vi.fn().mockRejectedValue(new Error('gone')) });
    const breaker = redisCircuitBreaker(fakeRedisClient(), { subscriber, keyPrefix: 'cb' });

    expect(() => breaker.dispose()).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
  });
});

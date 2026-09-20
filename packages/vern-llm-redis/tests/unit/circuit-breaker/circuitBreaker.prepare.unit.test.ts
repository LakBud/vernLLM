import { afterEach, describe, expect, it, vi } from 'vitest';

import { redisCircuitBreaker } from '../../../src/circuitBreaker.js';
import { READ_BUCKETS_SCRIPT } from '../../../src/internal/circuit-breaker/snapshotScript.js';
import { callContext, waitFor } from '../../breakerHelpers.js';
import { fakeRedisClient, fakeSubscriber, transitionMessage } from '../../helpers.js';

/**
 * TRANSITION_SCRIPT's reply: [from, to, failures, wonProbe, openedAt,
 * wonToken, breakdown, now, cooldown, grantAt, slots], all strings.
 */
function reply(
  from: string,
  to: string,
  fields: {
    won?: boolean;
    openedAt?: number;
    now?: number;
    cooldown?: number;
    grantAt?: number;
    slots?: number;
  } = {},
): string[] {
  return [
    from,
    to,
    '5',
    fields.won ? '1' : '0',
    String(fields.openedAt ?? 0),
    fields.won ? '3' : '',
    '',
    String(fields.now ?? 1000),
    String(fields.cooldown ?? 30_000),
    String(fields.grantAt ?? 0),
    String(fields.slots ?? 0),
  ];
}

const OUTCOME_ARG = 3;
const checks = (redis: ReturnType<typeof fakeRedisClient>) =>
  redis.eval.mock.calls.filter((call) => call[OUTCOME_ARG] === 'check');

/** A local clock the test moves by hand. */
function clock(start = 0) {
  let now = start;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  return { set: (value: number) => void (now = value) };
}

describe('redisCircuitBreaker prepare', () => {
  afterEach(() => vi.restoreAllMocks());

  it('declares the timeout VernLLM waits for it: 250ms by default, or the one it was given', () => {
    expect(redisCircuitBreaker(fakeRedisClient(), { pollIntervalMs: 0 }).prepareTimeoutMs).toBe(
      250,
    );
    expect(
      redisCircuitBreaker(fakeRedisClient(), { pollIntervalMs: 0, prepareTimeoutMs: 40 })
        .prepareTimeoutMs,
    ).toBe(40);
  });

  it.each([0, -1, Number.NaN, Infinity])('rejects prepareTimeoutMs %s', (value) => {
    expect(() => redisCircuitBreaker(fakeRedisClient(), { prepareTimeoutMs: value })).toThrowError(
      /prepareTimeoutMs/,
    );
  });

  it('reads the real state of a key this process has never seen', async () => {
    clock(0);
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValue(reply('closed', 'open', { openedAt: 900 }));
    const breaker = redisCircuitBreaker(redis, { pollIntervalMs: 0 });

    await breaker.prepare?.();

    expect(checks(redis)).toHaveLength(1);
    expect(breaker.getState?.()).toBe('open');
    expect(() => breaker.assertClosed()).toThrowError(/open/);
  });

  it('fires onStateChange for a change it discovers', async () => {
    clock(0);
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValue(reply('closed', 'open'));
    const onStateChange = vi.fn();
    const breaker = redisCircuitBreaker(redis, { pollIntervalMs: 0, onStateChange });

    await breaker.prepare?.();

    expect(onStateChange).toHaveBeenCalledWith('closed', 'open', 5, undefined, undefined);
  });

  it('leaves a key it already knows to be closed alone, no round trip', async () => {
    clock(0);
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValue(reply('closed', 'closed'));
    const breaker = redisCircuitBreaker(redis, { pollIntervalMs: 0 });
    await breaker.prepare?.();
    redis.eval.mockClear();

    await breaker.prepare?.();
    await breaker.prepare?.();

    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('uses the model specific key with isolateByModel', async () => {
    clock(0);
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValue(reply('closed', 'closed'));
    const breaker = redisCircuitBreaker(redis, {
      keyPrefix: 'cb',
      isolateByModel: true,
      pollIntervalMs: 0,
    });

    await breaker.prepare?.('gpt-4o');

    expect(redis.eval.mock.calls[0]![2]).toBe('cb:gpt-4o');
  });

  describe('an open circuit', () => {
    it('is not refreshed until its cooldown has probably run out, judged on the Redis clock', async () => {
      const local = clock(2000);
      const redis = fakeRedisClient();
      // Redis says it is 10000 while this process's clock says 2000: offset 8000.
      redis.eval.mockResolvedValue(
        reply('closed', 'open', { now: 10_000, openedAt: 9000, cooldown: 5000 }),
      );
      const breaker = redisCircuitBreaker(redis, { pollIntervalMs: 0 });
      await breaker.prepare?.();
      redis.eval.mockClear();

      local.set(5000); // Redis time 13000, open for 4000 of 5000
      await breaker.prepare?.();
      expect(redis.eval).not.toHaveBeenCalled();

      local.set(6000); // Redis time 14000, open for 5000: cooldown is over
      redis.eval.mockResolvedValue(reply('open', 'half-open', { won: true, now: 14_000 }));
      await breaker.prepare?.();
      expect(checks(redis)).toHaveLength(1);
    });

    it('lets the first call after the cooldown through as the trial, instead of rejecting it', async () => {
      const local = clock(0);
      const redis = fakeRedisClient();
      redis.eval.mockResolvedValue(
        reply('closed', 'open', { now: 0, openedAt: 0, cooldown: 1000 }),
      );
      const breaker = redisCircuitBreaker(redis, { pollIntervalMs: 0 });
      await breaker.prepare?.();

      local.set(1500);
      redis.eval.mockResolvedValue(reply('open', 'half-open', { won: true, now: 1500 }));
      await breaker.prepare?.();

      expect(() => breaker.assertClosed('m', callContext())).not.toThrow();
    });

    it('a burst of concurrent calls shares one refresh', async () => {
      const local = clock(0);
      const redis = fakeRedisClient();
      redis.eval.mockResolvedValue(reply('closed', 'open', { now: 0, cooldown: 100 }));
      const breaker = redisCircuitBreaker(redis, { pollIntervalMs: 0 });
      await breaker.prepare?.();
      redis.eval.mockClear();
      local.set(500);

      let finish!: (value: string[]) => void;
      redis.eval.mockReturnValue(new Promise((resolve) => (finish = resolve)));
      const burst = [breaker.prepare?.(), breaker.prepare?.(), breaker.prepare?.()];
      finish(reply('open', 'half-open', { won: true, now: 500 }));
      await Promise.all(burst);

      expect(checks(redis)).toHaveLength(1);
    });

    it('a seeded circuit, whose snapshot carried no cooldown, is refreshed once to learn it', async () => {
      clock(0);
      const redis = fakeRedisClient();
      redis.scan.mockResolvedValueOnce(['0', ['cb']]);
      redis.eval.mockResolvedValueOnce(['cb', 'open', '5', '123']);
      const breaker = redisCircuitBreaker(redis, { keyPrefix: 'cb', pollIntervalMs: 0 });
      await waitFor(() => expect(breaker.getState?.()).toBe('open'));

      redis.eval.mockResolvedValue(
        reply('open', 'open', { now: 200, openedAt: 150, cooldown: 30_000 }),
      );
      await breaker.prepare?.();
      redis.eval.mockClear();
      await breaker.prepare?.();

      expect(redis.eval).not.toHaveBeenCalled();
    });
  });

  describe('a half open circuit', () => {
    async function halfOpen(
      fields: { won?: boolean; grantAt?: number; slots?: number },
      options: { probeLeaseMs?: number } = {},
    ) {
      const local = clock(0);
      const redis = fakeRedisClient();
      redis.eval.mockResolvedValue(reply('open', 'half-open', { now: 0, ...fields }));
      const breaker = redisCircuitBreaker(redis, { pollIntervalMs: 0, ...options });
      await breaker.prepare?.();
      redis.eval.mockClear();
      return { local, redis, breaker };
    }

    it('holding a slot needs nothing: this call can use it', async () => {
      const { redis, breaker } = await halfOpen({ won: true });

      await breaker.prepare?.();

      expect(redis.eval).not.toHaveBeenCalled();
    });

    it('without a slot, refreshes when one is known to be free', async () => {
      const { redis, breaker } = await halfOpen({ slots: 2 });
      redis.eval.mockResolvedValue(reply('half-open', 'half-open', { won: true, slots: 1 }));

      await breaker.prepare?.();

      expect(checks(redis)).toHaveLength(1);
    });

    it('without a slot and none free, waits while the holder still has its lease', async () => {
      const { local, redis, breaker } = await halfOpen({ grantAt: 0 + 1, slots: 0 });
      local.set(50_000); // 49999ms into a 60000ms lease

      await breaker.prepare?.();

      expect(redis.eval).not.toHaveBeenCalled();
    });

    it("takes the trial over once the holder's lease has probably lapsed", async () => {
      const { local, redis, breaker } = await halfOpen({ grantAt: 1, slots: 0 });
      local.set(60_001);
      redis.eval.mockResolvedValue(reply('half-open', 'half-open', { won: true, now: 60_001 }));

      await breaker.prepare?.();

      expect(checks(redis)).toHaveLength(1);
    });

    it('never treats a circuit nobody has claimed a slot on as an expired lease', async () => {
      const { local, redis, breaker } = await halfOpen({ grantAt: 0, slots: 0 });
      local.set(10_000_000);

      await breaker.prepare?.();

      expect(redis.eval).not.toHaveBeenCalled();
    });
  });

  describe('a slow Redis', () => {
    it('costs a call the timeout once: calls after that skip the stuck refresh instead of joining it', async () => {
      const local = clock(0);
      const redis = fakeRedisClient();
      redis.eval.mockReturnValue(new Promise(() => {})); // never answers
      const breaker = redisCircuitBreaker(redis, { pollIntervalMs: 0, prepareTimeoutMs: 250 });

      void breaker.prepare?.(); // starts the refresh
      let joined = false;
      void breaker.prepare?.().then(() => (joined = true)); // within the timeout: joins it
      await Promise.resolve();
      expect(joined).toBe(false);

      local.set(300); // the refresh has now outlived the timeout
      await expect(breaker.prepare?.()).resolves.toBeUndefined();

      expect(checks(redis)).toHaveLength(1); // still only the one stuck refresh
    });
  });

  describe('when Redis fails or the adapter is shut down', () => {
    it('rejects, so VernLLM can fail open, and the next call tries again', async () => {
      clock(0);
      const redis = fakeRedisClient();
      const breaker = redisCircuitBreaker(redis, { pollIntervalMs: 0, logger: 'silent' });
      redis.eval.mockRejectedValueOnce(new Error('redis down'));

      await expect(breaker.prepare?.()).rejects.toThrow('redis down');

      redis.eval.mockResolvedValue(reply('closed', 'closed'));
      await expect(breaker.prepare?.()).resolves.toBeUndefined();
      expect(checks(redis)).toHaveLength(2);
    });

    it('does nothing after dispose', async () => {
      const redis = fakeRedisClient();
      const breaker = redisCircuitBreaker(redis, { pollIntervalMs: 0 });

      breaker.dispose();
      await breaker.prepare?.();

      expect(redis.eval).not.toHaveBeenCalled();
    });
  });

  it('learns a cooldown from a pub/sub message, so it can judge the next call without asking', async () => {
    const local = clock(0);
    const redis = fakeRedisClient();
    const subscriber = fakeSubscriber();
    const breaker = redisCircuitBreaker(redis, { subscriber, keyPrefix: 'cb', pollIntervalMs: 0 });

    subscriber.emit(
      'cb:events',
      transitionMessage({
        key: 'cb',
        state: 'open',
        failures: 5,
        openedAt: 900,
        now: 1000,
        cooldown: 5000,
      }),
    );
    local.set(2000); // Redis time 3000, open for 2100 of 5000
    await breaker.prepare?.();

    expect(redis.eval).not.toHaveBeenCalled();
  });
});

describe('redisCircuitBreaker readState', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns the state in Redis right now', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValue(['cb', 'open', '5', '123']);
    const breaker = redisCircuitBreaker(redis, { keyPrefix: 'cb', pollIntervalMs: 0 });

    await expect(breaker.readState?.()).resolves.toBe('open');
    expect(redis.eval).toHaveBeenCalledWith(READ_BUCKETS_SCRIPT, 1, 'cb');
  });

  it('also refreshes the local copy, and reports the change', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValue(['cb', 'half-open', '5', '123']);
    const onStateChange = vi.fn();
    const breaker = redisCircuitBreaker(redis, {
      keyPrefix: 'cb',
      pollIntervalMs: 0,
      onStateChange,
    });

    await breaker.readState?.();

    expect(breaker.getState?.()).toBe('half-open');
    expect(onStateChange).toHaveBeenCalledWith('closed', 'half-open', 5, undefined, undefined);
  });

  it('reads a key that no longer exists as closed', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValueOnce(['cb', 'open', '5', '123']);
    const breaker = redisCircuitBreaker(redis, { keyPrefix: 'cb', pollIntervalMs: 0 });
    await breaker.readState?.();

    redis.eval.mockResolvedValue(null);

    await expect(breaker.readState?.()).resolves.toBe('closed');
    expect(breaker.getState?.()).toBe('closed');
  });

  it('uses the model specific key with isolateByModel', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValue(null);
    const breaker = redisCircuitBreaker(redis, {
      keyPrefix: 'cb',
      isolateByModel: true,
      pollIntervalMs: 0,
    });

    await breaker.readState?.('gpt-4o');

    expect(redis.eval).toHaveBeenCalledWith(READ_BUCKETS_SCRIPT, 1, 'cb:gpt-4o');
  });

  it('rejects when Redis does, since a live answer was asked for', async () => {
    const redis = fakeRedisClient();
    redis.eval.mockRejectedValue(new Error('redis down'));

    await expect(redisCircuitBreaker(redis, { pollIntervalMs: 0 }).readState?.()).rejects.toThrow(
      'redis down',
    );
  });

  it('keeps the clock and cooldown it already knew, so a later prepare can still judge locally', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const redis = fakeRedisClient();
    redis.eval.mockResolvedValueOnce(
      reply('closed', 'open', { now: 0, openedAt: 0, cooldown: 5000 }),
    );
    const breaker = redisCircuitBreaker(redis, { keyPrefix: 'cb', pollIntervalMs: 0 });
    await breaker.prepare?.();

    redis.eval.mockResolvedValueOnce(['cb', 'open', '5', '0']);
    await breaker.readState?.();
    redis.eval.mockClear();
    now = 1000; // still inside the 5000ms cooldown

    await breaker.prepare?.();

    expect(redis.eval).not.toHaveBeenCalled();
  });
});

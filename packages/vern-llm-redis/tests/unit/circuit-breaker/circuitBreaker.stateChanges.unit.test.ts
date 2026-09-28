import { describe, expect, it, vi } from 'vitest';

import { redisCircuitBreaker } from '../../../src/circuitBreaker.js';
import { transitionReply, waitFor } from '../../breakerHelpers.js';
import { fakeRedisClient, fakeSubscriber, transitionMessage } from '../../helpers.js';

/** A reply the test settles by hand, to control the order replies land in. */
function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function setup() {
  const redis = fakeRedisClient();
  const subscriber = fakeSubscriber();
  const onStateChange = vi.fn();
  const breaker = redisCircuitBreaker(redis, {
    keyPrefix: 'cb',
    pollIntervalMs: 0,
    logger: 'silent',
    subscriber,
    onStateChange,
  });
  return { redis, subscriber, onStateChange, breaker };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('redisCircuitBreaker reports each state change once', () => {
  it('concurrent replies describing the same change fire once', async () => {
    const { redis, onStateChange, breaker } = setup();
    const replies = [deferred(), deferred(), deferred()];
    for (const reply of replies) redis.eval.mockReturnValueOnce(reply.promise);

    breaker.recordFailure('m');
    breaker.recordFailure('m');
    breaker.recordFailure('m');

    const opened = transitionReply('closed', 'open', { ver: 50 });
    const same = transitionReply('open', 'open', { ver: 50 });
    replies[0]!.resolve(opened);
    replies[1]!.resolve(same);
    replies[2]!.resolve(same);
    await settle();

    expect(onStateChange).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenCalledWith('closed', 'open', 5, 'm', undefined);
  });

  it.each(['reply first', 'echo first'])(
    "a change and this process's own pub/sub echo of it fire once (%s)",
    async (order) => {
      const { redis, subscriber, onStateChange, breaker } = setup();
      const reply = deferred();
      redis.eval.mockReturnValueOnce(reply.promise);
      const echo = () =>
        subscriber.emit(
          'cb:events',
          transitionMessage({
            key: 'cb',
            from: 'closed',
            state: 'open',
            failures: 5,
            openedAt: 0,
            ver: 60,
          }),
        );

      breaker.recordFailure('m');
      if (order === 'echo first') echo();
      reply.resolve(transitionReply('closed', 'open', { ver: 60 }));
      await settle();
      if (order === 'reply first') echo();

      expect(onStateChange).toHaveBeenCalledTimes(1);
      expect(breaker.getState?.()).toBe('open');
    },
  );

  it('a reply older than what is already known neither rolls the cache back nor fires', async () => {
    const { redis, onStateChange, breaker } = setup();
    const slow = deferred();
    redis.eval
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValueOnce(transitionReply('closed', 'open', { ver: 71 }));

    breaker.recordSuccess('m');
    breaker.recordFailure('m');
    await waitFor(() => expect(breaker.getState?.()).toBe('open'));

    // Written before the trip, answered after it.
    slow.resolve(transitionReply('closed', 'closed', { ver: 70 }));
    await settle();

    expect(breaker.getState?.()).toBe('open');
    expect(onStateChange).toHaveBeenCalledTimes(1);
  });

  it('catches up on a change it missed, reported from what it last knew', async () => {
    const { redis, onStateChange, breaker } = setup();
    redis.eval.mockResolvedValueOnce(transitionReply('closed', 'open', { ver: 80 }));
    breaker.recordFailure('m');
    await waitFor(() => expect(breaker.getState?.()).toBe('open'));

    // Another process closed it. This reply made no change itself.
    redis.eval.mockResolvedValueOnce(transitionReply('closed', 'closed', { ver: 82 }));
    breaker.recordSuccess('m');
    await waitFor(() => expect(onStateChange).toHaveBeenCalledTimes(2));

    expect(onStateChange).toHaveBeenLastCalledWith('open', 'closed', 5, 'm', undefined);
  });

  it("names Redis's own from when the observation is the change itself", async () => {
    const { subscriber, onStateChange } = setup();

    // This process never saw the circuit open, only the trial starting.
    subscriber.emit(
      'cb:events',
      transitionMessage({
        key: 'cb',
        from: 'open',
        state: 'half-open',
        failures: 5,
        openedAt: 0,
        ver: 90,
      }),
    );

    expect(onStateChange).toHaveBeenCalledWith('open', 'half-open', 5, undefined, undefined);
  });

  it('a live read of a hash with no version yet still wins', async () => {
    const { redis, onStateChange, breaker } = setup();
    redis.eval.mockResolvedValueOnce(transitionReply('closed', 'open', { ver: 95 }));
    breaker.recordFailure('m');
    await waitFor(() => expect(breaker.getState?.()).toBe('open'));

    redis.eval.mockResolvedValueOnce(['cb', 'half-open', '5', '0', '0']);

    await expect(breaker.readState?.()).resolves.toBe('half-open');
    expect(breaker.getState?.()).toBe('half-open');
    expect(onStateChange).toHaveBeenLastCalledWith('open', 'half-open', 5, undefined, undefined);
  });
});

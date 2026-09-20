import { describe, expect, it } from 'vitest';

import { redisCircuitBreaker } from '../../../src/circuitBreaker.js';
import { callContext, transitionReply, waitFor } from '../../breakerHelpers.js';
import { fakeRedisClient, fakeSubscriber, transitionMessage } from '../../helpers.js';

/** eval() argument positions: the script, numKeys and key come first, then TRANSITION_SCRIPT's ARGV. */
const OUTCOME_ARG = 3;
const TOKEN_ARG = 8;

const win = (token: string) => transitionReply('half-open', 'half-open', { token });
const noWin = () => transitionReply('half-open', 'half-open');

/** A breaker whose local copy says half-open with no slot held, so every call rejects and starts a check. */
function halfOpen() {
  const redis = fakeRedisClient();
  const subscriber = fakeSubscriber();
  const breaker = redisCircuitBreaker(redis, {
    keyPrefix: 'cb',
    subscriber,
    pollIntervalMs: 0,
    halfOpenProbes: 3,
    logger: 'silent',
  });
  const emit = (state: string) =>
    subscriber.emit('cb:events', transitionMessage({ key: 'cb', state, failures: 5, openedAt: 0 }));

  emit('half-open');
  return { redis, breaker, emit };
}

/** Lets every reply already queued on the fake Redis land in the local cache. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const admits = (breaker: ReturnType<typeof halfOpen>['breaker']) => {
  try {
    breaker.assertClosed('m', callContext());
    return true;
  } catch {
    return false;
  }
};

/** Starts `n` checks at once (each rejected call starts one) and lets the given replies land. */
async function overlappingChecks(
  { redis, breaker }: ReturnType<typeof halfOpen>,
  replies: string[][],
) {
  for (const reply of replies) redis.eval.mockResolvedValueOnce(reply);
  redis.eval.mockResolvedValue(noWin());

  for (let i = 0; i < replies.length; i++) expect(admits(breaker)).toBe(false);
  await waitFor(() => expect(redis.eval).toHaveBeenCalledTimes(replies.length));
  await settle();
}

describe('redisCircuitBreaker with overlapping checks', () => {
  it('keeps every slot that overlapping checks each won, not just one', async () => {
    const setup = halfOpen();

    await overlappingChecks(setup, [win('1'), win('1'), win('1')]);

    expect([admits(setup.breaker), admits(setup.breaker), admits(setup.breaker)]).toEqual([
      true,
      true,
      true,
    ]);
    expect(admits(setup.breaker)).toBe(false);
  });

  it('only counts slots of the same trial: a win under a new epoch replaces the old ones', async () => {
    const setup = halfOpen();

    await overlappingChecks(setup, [win('1'), win('1'), win('2')]);

    expect(admits(setup.breaker)).toBe(true);
    expect(admits(setup.breaker)).toBe(false);
  });

  it("each call's outcome presents its epoch's token, one slot at a time", async () => {
    const setup = halfOpen();
    await overlappingChecks(setup, [win('4'), win('4'), win('4')]);

    const [first, second] = [callContext(), callContext()];
    setup.breaker.assertClosed('m', first);
    setup.breaker.assertClosed('m', second);
    setup.redis.eval.mockClear();
    setup.breaker.recordSuccess('m', first);
    setup.breaker.recordFailure('m', second);
    await waitFor(() => expect(setup.redis.eval).toHaveBeenCalledTimes(2));

    const outcomes = setup.redis.eval.mock.calls.map((call) => [
      call[OUTCOME_ARG],
      call[TOKEN_ARG],
    ]);
    expect(outcomes).toEqual([
      ['success', '4'],
      ['failure', '4'],
    ]);
    expect(admits(setup.breaker)).toBe(true); // the third slot is still there
  });

  it('a live read of the same half-open state leaves the held slots alone', async () => {
    const setup = halfOpen();
    await overlappingChecks(setup, [win('1'), win('1')]);

    setup.redis.eval.mockResolvedValue(['cb', 'half-open', '5', '0']);
    await setup.breaker.readState?.();

    expect([admits(setup.breaker), admits(setup.breaker), admits(setup.breaker)]).toEqual([
      true,
      true,
      false,
    ]);
  });

  it('drops every held slot once the circuit leaves half-open, so none carry into the next trial', async () => {
    const setup = halfOpen();
    await overlappingChecks(setup, [win('1'), win('1')]);

    setup.emit('closed');
    setup.emit('half-open');

    expect(admits(setup.breaker)).toBe(false);
  });
});

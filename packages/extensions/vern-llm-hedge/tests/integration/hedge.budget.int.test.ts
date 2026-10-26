import { VernLLM } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { hedgeMiddleware } from '../../src/index.js';
import { eventProbe, heldClient, settle, targetChain, waitFor } from '../helpers.js';

const call = { userContent: 'hi', jsonMode: false as const };

// A token for every fourth eligible call, held up to two.
function setup() {
  const primary = heldClient('primary');
  const chain = targetChain({ primary: primary.client });
  const probe = eventProbe('hedge.decision');
  const llm = new VernLLM({
    ...chain.options,
    middleware: [
      probe.middleware as never,
      hedgeMiddleware({ logger: 'silent', delay: 25, budget: { ratio: 0.25, burst: 2 } }),
    ],
  });
  const events = probe.events as { outcome: string }[];

  /** A call whose first target is still silent when the delay passes. */
  async function slowCall() {
    const index = primary.requests.length;
    const pending = llm.call(call);
    await waitFor(() => primary.requests.length === index + 1);
    // Past the 25ms delay: a hedge, if the budget allowed one, has started and `b` has answered.
    await settle(70);
    primary.requests[index]!.answer();
    await pending;
  }

  /** A call whose first target answers before the delay. */
  async function fastCall() {
    const index = primary.requests.length;
    const pending = llm.call(call);
    await waitFor(() => primary.requests.length === index + 1);
    primary.requests[index]!.answer();
    await pending;
  }

  return { chain, events, slowCall, fastCall, outcomes: () => events.map((e) => e.outcome) };
}

describe('the budget', () => {
  it('stops hedges at about its ratio when every call is slow', async () => {
    const { chain, slowCall, outcomes } = setup();

    for (let call = 0; call < 12; call++) await slowCall();

    expect(outcomes()).toEqual([
      ...['budget', 'budget', 'budget', 'won'],
      ...['budget', 'budget', 'budget', 'won'],
      ...['budget', 'budget', 'budget', 'won'],
    ]);
    expect(chain.tried().filter((name) => name === 'b')).toHaveLength(3);
  });

  it('waits for its own answer when the budget holds no token', async () => {
    const { chain, slowCall, outcomes } = setup();

    await slowCall();

    expect(outcomes()).toEqual(['budget']);
    expect(chain.tried()).toEqual(['primary']);
  });

  it('is refilled by calls that answered in time', async () => {
    const { slowCall, fastCall, outcomes } = setup();

    for (let call = 0; call < 4; call++) await slowCall(); // the fourth takes the one token
    await slowCall(); // empty again
    for (let call = 0; call < 3; call++) await fastCall(); // three quarters of a token back
    await slowCall(); // a whole token again

    expect(outcomes()).toEqual([
      ...['budget', 'budget', 'budget', 'won'],
      'budget',
      ...['not_needed', 'not_needed', 'not_needed'],
      'won',
    ]);
  });
});

import { VernLLM } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { hedgeMiddleware, type HedgeOptions } from '../../src/index.js';
import {
  eventProbe,
  heldClient,
  serverError,
  settle,
  targetChain,
  textResponse,
  waitFor,
} from '../helpers.js';

const call = { userContent: 'hi', jsonMode: false as const };

function setup(options: HedgeOptions, entries: Parameters<typeof targetChain>[0] = {}) {
  const adapted = eventProbe('hedge.adapt', 'adapt-events');
  const primary = heldClient('primary');
  const b = heldClient('b');
  const chain = targetChain({ primary: primary.client, b: b.client, ...entries });
  const probe = eventProbe('hedge.decision');
  const llm = new VernLLM({
    ...chain.options,
    middleware: [
      probe.middleware as never,
      adapted.middleware as never,
      hedgeMiddleware({ delay: 20, budget: { ratio: 1, burst: 4 }, logger: 'silent', ...options }),
    ],
  });

  /** Fills the bucket: each call the first target answers in time adds a token and spends none. */
  async function prime(calls: number) {
    for (let i = 0; i < calls; i++) {
      const index = primary.requests.length;
      const pending = llm.call(call);
      await waitFor(() => primary.requests.length === index + 1);
      primary.requests[index]!.answer();
      await pending;
    }
  }

  const events = probe.events as Record<string, unknown>[];
  return {
    llm,
    chain,
    primary,
    b,
    prime,
    last: () => events[events.length - 1],
    adaptEvents: adapted.events as Record<string, unknown>[],
  };
}

describe('maxHedges', () => {
  it('sends a second hedge one delay after the first, and keeps whichever answers first', async () => {
    const { llm, chain, primary, b, prime, last } = setup({ maxHedges: 2 });
    await prime(2);

    // `c` answers at once, so it wins once the second hedge reaches it.
    expect(await llm.call(call)).toBe('c');

    expect(chain.tried().slice(2)).toEqual(['primary', 'b', 'c']);
    expect(last()).toEqual({
      v: 1,
      outcome: 'won',
      delayMs: 20,
      target: 'b',
      hedges: 2,
      winner: 'c',
      ms: expect.any(Number),
    });
    await settle();
    expect(primary.requests[2]!.aborted).toBe(true);
    expect(b.requests[0]!.aborted).toBe(true);
  });

  it('does not send the second hedge when the first one answers within its delay', async () => {
    const { llm, chain, b, prime, last } = setup({ maxHedges: 2 });
    await prime(2);

    const pending = llm.call(call);
    await waitFor(() => b.requests.length === 1);
    b.requests[0]!.answer();

    expect(await pending).toBe('b');
    expect(chain.tried().slice(2)).toEqual(['primary', 'b']);
    expect(last()).not.toHaveProperty('hedges');
  });

  it('sends the next hedge when one fails, since only an answer or the main chain ends the wait', async () => {
    // The first hedge to `b` falls through `c`, which fails once, so that hedge is lost. The
    // second hedge reaches `c` again, which now answers.
    const { llm, prime, last } = setup(
      { maxHedges: 2 },
      { b: [serverError()], c: [serverError(), textResponse('c')] },
    );
    await prime(2);

    expect(await llm.call(call)).toBe('c');

    expect(last()).toMatchObject({ outcome: 'won', hedges: 2 });
  });

  it('takes a budget token for each hedge, and stops sending when the bucket is empty', async () => {
    const { llm, chain, primary, last } = setup({ maxHedges: 3, budget: { ratio: 1, burst: 1 } });

    const pending = llm.call(call);
    await waitFor(() => chain.tried().length === 2);
    await settle(80);

    // One token: the main chain and one hedge only.
    expect(chain.tried()).toEqual(['primary', 'b']);
    primary.requests[0]!.answer();
    expect(await pending).toBe('primary');
    expect(last()).toMatchObject({ outcome: 'lost', target: 'b' });
    expect(last()).not.toHaveProperty('hedges');
  });

  it('names the hedge target whose answer was kept', async () => {
    const c = heldClient('c');
    const { llm, chain, b, prime, last } = setup({ maxHedges: 2 }, { c: c.client });
    await prime(2);

    const pending = llm.call(call);
    await waitFor(() => chain.tried().length === 5);
    b.requests[0]!.answer('b from hedge');

    expect(await pending).toBe('b from hedge');
    expect(last()).toMatchObject({ outcome: 'won', hedges: 2, winner: 'b' });
  });

  it('does not send a later hedge past the call`s deadline, which the core ends by cancelling the call', async () => {
    const { llm, chain, primary, b } = setup({ maxHedges: 2 });

    // The first hedge goes out at 20 ms, inside the deadline; a second would go out at 40 ms.
    const pending = Promise.allSettled([llm.call({ ...call, deadlineMs: 30 })]);
    await waitFor(() => chain.tried().length === 2);
    await settle(60);

    expect(chain.tried()).toEqual(['primary', 'b']);
    primary.requests[0]?.answer();
    b.requests[0]?.answer();
    await pending;
  });

  it('counts a win by any hedge for the first target`s win rate', async () => {
    const { llm, prime, adaptEvents } = setup({
      maxHedges: 2,
      adapt: { window: 2, minHedges: 2, highWinRate: 0.5, lowWinRate: 0.1 },
    });
    await prime(4);

    // `c` answers at once, so the second hedge wins each time.
    await llm.call(call);
    await llm.call(call);

    expect(adaptEvents).toEqual([{ action: 'slow', target: 'primary', winRate: 1, hedges: 2 }]);
  });

  it('waits the longer delay for a cached prefix before each hedge', async () => {
    const { llm, chain, primary, prime } = setup({ maxHedges: 2, cacheAware: true });
    const index = primary.requests.length;
    const warming = llm.call(call);
    await waitFor(() => primary.requests.length === index + 1);
    primary.requests[index]!.answer('primary', 500, 400);
    await warming;
    await prime(2);
    const before = chain.tried().length;

    const pending = llm.call(call);
    await settle(30);
    // 20 ms would have sent a hedge by now, the doubled 40 ms has not.
    expect(chain.tried().length).toBe(before + 1);
    await waitFor(() => chain.tried().length === before + 3);
    expect(await pending).toBe('c');
  });
});

describe('a call that ends before the delay', () => {
  it('is reported as failed when the whole chain failed', async () => {
    const { llm, primary, last } = setup(
      { delay: 200 },
      { b: [serverError()], c: [serverError()] },
    );

    const pending = llm.call(call).catch((error: unknown) => error);
    await waitFor(() => primary.requests.length === 1);
    primary.requests[0]!.fail(serverError());

    expect(await pending).toBeInstanceOf(Error);
    await settle();
    expect(last()).toEqual({ v: 1, outcome: 'failed', delayMs: 200 });
  });

  it('is reported as aborted when the caller cancels it during the delay', async () => {
    const { llm, chain, primary, last } = setup({ delay: 200 });
    const controller = new AbortController();

    const pending = llm.call({ ...call, signal: controller.signal } as never).catch(String);
    await waitFor(() => primary.requests.length === 1);
    controller.abort();

    await pending;
    await settle();
    expect(chain.tried()).toEqual(['primary']);
    expect(last()).toEqual({ v: 1, outcome: 'aborted', delayMs: 200 });
  });
});

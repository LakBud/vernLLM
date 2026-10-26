import { VernLLM } from 'vern-llm';
import { describe, expect, it, vi } from 'vitest';

import { hedgeMiddleware, type HedgeOptions } from '../../src/index.js';
import { eventProbe, heldClient, serverError, settle, targetChain, waitFor } from '../helpers.js';

const call = { userContent: 'hi', jsonMode: false as const };

// One token per eligible call, so every slow call may hedge.
const budget = { ratio: 1, burst: 1 };

function setup(options: HedgeOptions, entries: Parameters<typeof targetChain>[0] = {}) {
  const chain = targetChain(entries);
  const probe = eventProbe('hedge.decision');
  const attempts: string[] = [];
  const llm = new VernLLM({
    ...chain.options,
    middleware: [
      probe.middleware as never,
      // Sees every attempt of every chain, to show the hedge's own go through the same hooks.
      {
        name: 'attempts',
        dispatch: async (_request, next, ctx) => {
          attempts.push(ctx.requestedProvider);
          await next();
        },
      },
      hedgeMiddleware({ logger: 'silent', budget, ...options }),
    ],
  });
  return { llm, chain, attempts, events: probe.events as Record<string, unknown>[] };
}

describe('a slow first target', () => {
  it('gets a hedge to the next target, and the faster answer is returned', async () => {
    const primary = heldClient('primary');
    const { llm, chain, events } = setup({ delay: 20 }, { primary: primary.client });

    expect(await llm.call(call)).toBe('b');

    expect(chain.tried()).toEqual(['primary', 'b']);
    expect(events).toEqual([
      { v: 1, outcome: 'won', delayMs: 20, target: 'b', ms: expect.any(Number) },
    ]);
    expect(events[0]!.ms as number).toBeGreaterThanOrEqual(15);
  });

  it('is cancelled at its provider once the hedge has answered', async () => {
    const primary = heldClient('primary');
    const { llm } = setup({ delay: 10 }, { primary: primary.client });

    await llm.call(call);
    await settle();

    expect(primary.requests).toHaveLength(1);
    expect(primary.requests[0]!.aborted).toBe(true);
  });

  it('keeps its own answer when that arrives after the hedge started, and cancels the hedge', async () => {
    const primary = heldClient('primary');
    const b = heldClient('b');
    const { llm, events } = setup({ delay: 10 }, { primary: primary.client, b: b.client });

    const pending = llm.call(call);
    await waitFor(() => b.requests.length === 1);
    primary.requests[0]!.answer();

    expect(await pending).toBe('primary');
    await settle();
    expect(b.requests[0]!.aborted).toBe(true);
    expect(events[0]).toMatchObject({ outcome: 'lost', target: 'b' });
  });

  it('gives the hedge its own fallback, since it gets the rest of the order', async () => {
    const primary = heldClient('primary');
    const { llm, chain, events } = setup(
      { delay: 10 },
      { primary: primary.client, b: [serverError()] },
    );

    expect(await llm.call(call)).toBe('c');

    expect(chain.tried()).toEqual(['primary', 'b', 'c']);
    expect(events[0]).toMatchObject({ outcome: 'won', target: 'b' });
  });

  it('runs every middleware attempt hook for the hedge too', async () => {
    const primary = heldClient('primary');
    const { llm, attempts } = setup({ delay: 10 }, { primary: primary.client });

    await llm.call(call);

    expect(attempts).toEqual(['primary', 'b']);
  });
});

describe('a fast first target', () => {
  it('is never hedged', async () => {
    const { llm, chain, events } = setup({ delay: 30 });

    expect(await llm.call(call)).toBe('primary');
    await settle(60);

    expect(chain.tried()).toEqual(['primary']);
    expect(events).toEqual([{ v: 1, outcome: 'not_needed', delayMs: 30 }]);
  });

  it('leaves no timer behind, so the delay never outlives the call', async () => {
    const { llm } = setup({ delay: 60_000 });
    const scheduled = vi.spyOn(globalThis, 'setTimeout');
    const cleared = vi.spyOn(globalThis, 'clearTimeout');

    try {
      await llm.call(call);

      // The hedge's 60 second timer was started, and its handle was cleared when the call ended.
      const index = scheduled.mock.calls.findIndex(([, ms]) => ms === 60_000);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(cleared).toHaveBeenCalledWith(scheduled.mock.results[index]!.value);
    } finally {
      scheduled.mockRestore();
      cleared.mockRestore();
    }
  });
});

describe('where the hedge goes', () => {
  it('follows the order of the call, not the declared one', async () => {
    const b = heldClient('b');
    const { llm, chain } = setup({ delay: 10 }, { b: b.client });

    // `b` goes first, so the hedge goes to `c`, the next one in this call's order.
    expect(await llm.call({ ...call, targets: ['b', 'c', 'primary'] })).toBe('c');

    expect(chain.tried()).toEqual(['b', 'c']);
  });

  it('can be the same target again', async () => {
    const primary = heldClient('primary');
    const { llm, events } = setup(
      { delay: 10, targets: (ctx) => [ctx.targets[0]!.name] },
      { primary: primary.client },
    );

    const pending = llm.call(call);
    await waitFor(() => primary.requests.length === 2);
    primary.requests[1]!.answer('again');

    expect(await pending).toBe('again');
    await settle();
    expect(primary.requests[0]!.aborted).toBe(true);
    expect(events[0]).toMatchObject({ outcome: 'won', target: 'primary' });
  });

  it('ignores names the order does not contain, and repeats', async () => {
    const primary = heldClient('primary');
    const { llm, chain } = setup(
      { delay: 10, targets: () => ['nope', 'b', 'b'] },
      { primary: primary.client },
    );

    expect(await llm.call(call)).toBe('b');

    expect(chain.tried()).toEqual(['primary', 'b']);
  });
});

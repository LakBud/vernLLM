import { VernLLM } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { hedgeMiddleware } from '../../src/index.js';
import { eventProbe, heldClient, serverError, settle, targetChain, waitFor } from '../helpers.js';

const call = { userContent: 'hi', jsonMode: false as const };

function setup(entries: Parameters<typeof targetChain>[0]) {
  const chain = targetChain(entries);
  const probe = eventProbe('hedge.decision');
  const llm = new VernLLM({
    ...chain.options,
    middleware: [
      probe.middleware as never,
      hedgeMiddleware({ logger: 'silent', delay: 10, budget: { ratio: 1, burst: 1 } }),
    ],
  });
  return { llm, chain, events: probe.events as Record<string, unknown>[] };
}

describe('when a chain fails', () => {
  it('keeps the hedge`s answer when the first target fails after the hedge started', async () => {
    const primary = heldClient('primary');
    const b = heldClient('b');
    const { llm, events } = setup({ primary: primary.client, b: b.client });

    const pending = llm.call(call);
    await waitFor(() => b.requests.length === 1);
    // The main chain fails, and falls back to `b` itself; the hedge's own request to `b` is first.
    primary.requests[0]!.fail(serverError());
    await waitFor(() => b.requests.length === 2);
    b.requests[0]!.answer('hedge answer');

    expect(await pending).toBe('hedge answer');
    await settle();
    expect(b.requests[1]!.aborted).toBe(true);
    expect(events[0]).toMatchObject({ outcome: 'won', target: 'b' });
  });

  it('throws the main chain`s error when both fail', async () => {
    const primary = heldClient('primary');
    const { llm, chain, events } = setup({
      primary: primary.client,
      b: [serverError()],
      c: [serverError()],
    });

    const outcome = llm.call(call).then(
      () => undefined,
      (error: Error) => error,
    );
    // The hedge chain, `b` then `c`, has failed by the time the main chain does.
    await waitFor(() => chain.tried().includes('c'));
    await settle(20);
    primary.requests[0]!.fail(serverError());

    const error = await outcome;
    // The main chain tried all three targets; the hedge chain, which is not the one thrown, two.
    expect(error?.message).toContain('3 providers attempted and failed');
    expect(chain.tried()).toEqual(['primary', 'b', 'c', 'b', 'c']);
    expect(events).toEqual([{ v: 1, outcome: 'lost', delayMs: 10, target: 'b' }]);
  });
});

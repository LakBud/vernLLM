import { VernLLM } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { hedgeMiddleware } from '../../src/index.js';
import { eventProbe, heldStreamClient, settle, targetChain, waitFor } from '../helpers.js';

const call = { userContent: 'hi', jsonMode: false as const, stream: true as const };

function setup(entries: {
  primary: ReturnType<typeof heldStreamClient>;
  b: ReturnType<typeof heldStreamClient>;
}) {
  const chain = targetChain({ primary: entries.primary.client, b: entries.b.client });
  const probe = eventProbe('hedge.decision');
  const llm = new VernLLM({
    ...chain.options,
    middleware: [
      probe.middleware as never,
      hedgeMiddleware({ delay: 10, budget: { ratio: 1, burst: 1 }, logger: 'silent' }),
    ],
  });
  return { llm, events: probe.events as Record<string, unknown>[] };
}

describe('a slow first stream', () => {
  it('loses to the hedge whose stream opens first, and is closed at its provider', async () => {
    const primary = heldStreamClient('primary');
    const b = heldStreamClient('b');
    const { llm, events } = setup({ primary, b });

    const pending = llm.call(call);
    await waitFor(() => b.requests.length === 1);
    b.requests[0]!.open();
    const stream = await pending;
    for await (const chunk of stream.chunks) void chunk;

    await expect(stream.finalResult).resolves.toBe('b');
    await settle();
    expect(primary.requests[0]!.aborted).toBe(true);
    expect(events[0]).toMatchObject({ outcome: 'won', target: 'b' });
  });

  it('keeps its own stream when that opens after the hedge started, and closes the hedge', async () => {
    const primary = heldStreamClient('primary');
    const b = heldStreamClient('b');
    const { llm, events } = setup({ primary, b });

    const pending = llm.call(call);
    await waitFor(() => b.requests.length === 1);
    primary.requests[0]!.open();
    const stream = await pending;
    for await (const chunk of stream.chunks) void chunk;

    await expect(stream.finalResult).resolves.toBe('primary');
    await settle();
    expect(b.requests[0]!.aborted).toBe(true);
    expect(events[0]).toMatchObject({ outcome: 'lost', target: 'b' });
  });

  it('is still answered by its own stream when the hedge`s stream fails', async () => {
    const primary = heldStreamClient('primary');
    const b = heldStreamClient('b');
    const { llm } = setup({ primary, b });

    const pending = llm.call(call);
    await waitFor(() => b.requests.length === 1);
    b.requests[0]!.fail(Object.assign(new Error('server error'), { status: 500 }));
    await settle();
    primary.requests[0]!.open();
    const stream = await pending;
    for await (const chunk of stream.chunks) void chunk;

    await expect(stream.finalResult).resolves.toBe('primary');
  });

  it('is never hedged when it opens within the delay', async () => {
    const primary = heldStreamClient('primary');
    const b = heldStreamClient('b');
    const { llm, events } = setup({ primary, b });

    const pending = llm.call(call);
    await waitFor(() => primary.requests.length === 1);
    primary.requests[0]!.open();
    const stream = await pending;
    for await (const chunk of stream.chunks) void chunk;

    await expect(stream.finalResult).resolves.toBe('primary');
    expect(b.requests).toHaveLength(0);
    expect(events[0]).toMatchObject({ outcome: 'not_needed' });
  });
});

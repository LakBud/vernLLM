import { VernLLM } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { routerMiddleware, type RouterOptions } from '../../src/index.js';
import { eventProbe, targetChain } from '../helpers.js';

const call = { userContent: 'hi', jsonMode: false as const };

/** Holds every call to `name` until `release()` is called. */
function gateTarget(chain: ReturnType<typeof targetChain>, name: 'primary' | 'b' | 'c') {
  const client = chain[name].client.chat.completions;
  const original = client.create;
  let release: () => void = () => undefined;
  let gate = new Promise<void>((resolve) => (release = resolve));
  client.create = (async (...args: Parameters<typeof original>) => {
    await gate;
    return original(...args);
  }) as typeof original;
  return {
    release: () => {
      release();
      gate = Promise.resolve();
    },
  };
}

function setup(router: RouterOptions) {
  const chain = targetChain();
  const probe = eventProbe('router.decision');
  const llm = new VernLLM({
    ...chain.options,
    middleware: [probe.middleware as never, routerMiddleware({ logger: 'silent', ...router })],
  });
  return { llm, chain, events: probe.events as Record<string, unknown>[] };
}

const head = (event: Record<string, unknown> | undefined): string | undefined =>
  (event?.order as string[] | undefined)?.[0];

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

describe('leastBusy', () => {
  it('sends the next call to the target with fewer attempts in flight', async () => {
    const { llm, chain, events } = setup({
      random: () => 0,
      routes: [{ name: 'lb', targets: ['primary', 'b'], strategy: 'least-busy' }],
    });
    const hold = gateTarget(chain, 'primary');

    const first = llm.call(call);
    await tick();
    // primary has one attempt in flight now; the sampled pair is primary and b.
    const second = llm.call(call);
    await tick();

    // The second call avoided the busy primary and has already been answered by b.
    expect(chain.tried()).toEqual(['b']);
    expect(events).toHaveLength(1);
    hold.release();
    await Promise.all([first, second]);

    expect(chain.tried().sort()).toEqual(['b', 'primary']);
    expect(events.map((event) => head(event)).sort()).toEqual(['b', 'primary']);
    expect(events[0]).toMatchObject({ strategy: 'least-busy' });
  });

  it('counts an attempt out again when it finishes, even when it fails', async () => {
    const chain = targetChain({ primary: [new Error('boom')] });
    const probe = eventProbe('router.decision');
    const llm = new VernLLM({
      ...chain.options,
      middleware: [
        probe.middleware as never,
        routerMiddleware({
          logger: 'silent',
          random: () => 0,
          routes: [{ name: 'lb', targets: ['primary', 'b'], strategy: 'least-busy' }],
        }),
      ],
    });

    await llm.call(call);
    await llm.call(call);

    const heads = (probe.events as { order: string[] }[]).map((event) => event.order[0]);
    // Both calls start with primary: a failed attempt left nothing in flight to avoid it.
    expect(heads).toEqual(['primary', 'primary']);
  });

  it('honours weights when sampling', async () => {
    const { llm, events } = setup({
      random: () => 0,
      routes: [
        {
          name: 'lb',
          strategy: { type: 'least-busy', weights: { primary: 0, b: 1, c: 1 } },
        },
      ],
    });

    await llm.call(call);

    expect(head(events[0])).not.toBe('primary');
  });
});

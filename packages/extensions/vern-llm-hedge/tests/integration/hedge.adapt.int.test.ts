import { VernLLM } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { hedgeMiddleware, type HedgeOptions } from '../../src/index.js';
import { eventProbe, heldClient, settle, targetChain, waitFor } from '../helpers.js';

const call = { userContent: 'hi', jsonMode: false as const };

const adapt = { window: 4, minHedges: 4, lowWinRate: 0.25, highWinRate: 0.5, pauseMs: 80 };

function setup(options: HedgeOptions, holdSecond: boolean) {
  const primary = heldClient('primary');
  const b = heldClient('b');
  const chain = targetChain({ primary: primary.client, ...(holdSecond && { b: b.client }) });
  const decisions = eventProbe('hedge.decision');
  const adapted = eventProbe('hedge.adapt', 'adapt-events');
  const asked: number[] = [];
  const llm = new VernLLM({
    ...chain.options,
    middleware: [
      decisions.middleware as never,
      adapted.middleware as never,
      hedgeMiddleware({
        stats: {
          quantile: (_filter, q) => {
            asked.push(q);
            return 10;
          },
        },
        statsTtlMs: 0,
        budget: { ratio: 1, burst: 4 },
        logger: 'silent',
        ...options,
      }),
    ],
  });

  /** A hedged call the first target answers, after the hedge was sent: the hedge loses. */
  async function hedgeLoses() {
    const [p, h] = [primary.requests.length, b.requests.length];
    const pending = llm.call(call);
    await waitFor(() => b.requests.length === h + 1);
    primary.requests[p]!.answer();
    await pending;
  }

  return {
    llm,
    chain,
    primary,
    asked,
    hedgeLoses,
    adaptEvents: adapted.events as Record<string, unknown>[],
    decisions: decisions.events as Record<string, unknown>[],
  };
}

describe('a first target whose hedges rarely win', () => {
  it('is waited for at a higher quantile', async () => {
    const { hedgeLoses, asked, adaptEvents } = setup({ adapt }, true);

    for (let i = 0; i < 4; i++) await hedgeLoses();
    await hedgeLoses();

    expect(adaptEvents).toEqual([
      { action: 'raise_quantile', target: 'primary', winRate: 0, hedges: 4, quantile: 0.97 },
    ]);
    // The four calls asked for the configured quantile, then the raised one.
    expect(asked.slice(0, 4).every((q) => q === 0.95)).toBe(true);
    expect(asked[4]).toBeCloseTo(0.97);
  });

  it('stops being hedged at the highest quantile, and is hedged again after the pause', async () => {
    const { llm, hedgeLoses, primary, chain, decisions, adaptEvents } = setup(
      { adapt: { ...adapt, maxQuantile: 0.96 } },
      true,
    );

    for (let i = 0; i < 4; i++) await hedgeLoses(); // raised to 0.96
    for (let i = 0; i < 4; i++) await hedgeLoses(); // nowhere to go but a pause
    expect(adaptEvents.map((event) => event.action)).toEqual(['raise_quantile', 'pause']);

    const index = primary.requests.length;
    const paused = llm.call(call);
    await waitFor(() => primary.requests.length === index + 1);
    primary.requests[index]!.answer();
    await paused;
    expect(decisions.at(-1)).toMatchObject({ outcome: 'paused' });
    const triedWhilePaused = chain.tried().length;
    expect(chain.tried().at(-1)).toBe('primary');

    await settle(100);
    await hedgeLoses();
    expect(chain.tried().length).toBeGreaterThan(triedWhilePaused + 1);
    expect(decisions.at(-1)).toMatchObject({ outcome: 'lost' });
  });

  it('is paused at once when the delay is a number, since there is no quantile to raise', async () => {
    const { hedgeLoses, adaptEvents } = setup({ delay: 10, adapt }, true);

    for (let i = 0; i < 4; i++) await hedgeLoses();

    expect(adaptEvents).toEqual([{ action: 'pause', target: 'primary', winRate: 0, hedges: 4 }]);
  });

  it('is left alone when adaptation is not asked for', async () => {
    const { hedgeLoses, asked, adaptEvents } = setup({}, true);

    for (let i = 0; i < 6; i++) await hedgeLoses();

    expect(adaptEvents).toEqual([]);
    expect(new Set(asked)).toEqual(new Set([0.95]));
  });
});

describe('a first target whose hedges often win', () => {
  it('is reported as slow once, not on every call after', async () => {
    const { llm, adaptEvents } = setup({ adapt }, false);

    for (let i = 0; i < 6; i++) expect(await llm.call(call)).toBe('b');

    expect(adaptEvents).toEqual([{ action: 'slow', target: 'primary', winRate: 1, hedges: 4 }]);
  });
});

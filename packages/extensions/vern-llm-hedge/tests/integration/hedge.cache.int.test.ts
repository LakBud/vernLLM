import { VernLLM } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { hedgeMiddleware } from '../../src/index.js';
import { eventProbe, heldClient, targetChain } from '../helpers.js';

const params = {
  cacheKey: 'k',
  ttl: 60_000,
  call: { userContent: 'hi', jsonMode: false as const },
};

describe('cachedCall', () => {
  it('hedges a slow first target, and caches the answer the hedge won with', async () => {
    const primary = heldClient('primary');
    const chain = targetChain({ primary: primary.client });
    const probe = eventProbe('hedge.decision');
    const llm = new VernLLM({
      ...chain.options,
      middleware: [
        probe.middleware as never,
        hedgeMiddleware({ delay: 10, budget: { ratio: 1, burst: 1 }, logger: 'silent' }),
      ],
    });

    expect(await llm.cachedCall(params)).toBe('b');
    expect(await llm.cachedCall(params)).toBe('b');

    expect(chain.tried()).toEqual(['primary', 'b']);
    // The second call is a cache hit: it settles at once, so it is not hedged.
    expect(probe.events).toMatchObject([
      { outcome: 'won', target: 'b' },
      { outcome: 'not_needed' },
    ]);
  });
});

import { describe, expect, it, vi } from 'vitest';

import { type VernLLMEvent } from '../../src/types/index.js';
import { VernLLM } from '../../src/vernLLM.js';
import { createMockClient, jsonResponse, FakeApiError } from '../helpers.js';

/**
 * Verifies status-differentiated backoff end to end through a real retry
 * loop, without ever waiting out a real delay: fake timers stand in for
 * the backoff wait, and the computed delay is read straight off the
 * "retry" event VernLLM already reports before each wait (same pattern
 * `vernLLM.events.unit.test.ts` uses for retry events), rather than
 * measured from wall-clock time.
 *
 * `getBackoffDelay` applies *full jitter*: it picks uniformly over
 * `[0, exp]`, where `exp` is the capped exponential value that differs
 * by status (see `retry.utils.ts`). Comparing raw delays (or even
 * averages of many delays) across statuses is inherently flaky, since
 * the `[0, exp]` ranges overlap for adjacent statuses and a mean over a
 * uniform distribution has real sampling variance. To test the intended
 * behavior deterministically, `Math.random` is pinned to a fixed value
 * here, which collapses `fullJitter(exp)` to `fixedRandom * exp` and lets
 * the exact per-status delay be asserted directly instead of inferred
 * from noisy averages.
 */
describe('VernLLM workflow, status differentiated backoff', () => {
  const FIXED_RANDOM = 0.7;

  /** One failed attempt against the given status, followed by a success. */
  async function backoffDelayFor(status: number): Promise<number> {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(FIXED_RANDOM);
    try {
      const onEvent = vi.fn();
      const { client } = createMockClient([
        new FakeApiError('boom', status),
        jsonResponse({ ok: true }),
      ]);

      const llm = new VernLLM({
        client,
        model: 'm',
        maxRetries: 1,
        baseDelayMs: 200,
        onEvent,
      });

      const callPromise = llm.call({ userContent: 'u' });
      await vi.runAllTimersAsync();
      await callPromise;

      const retryEvent = onEvent.mock.calls
        .map((c) => c[0] as VernLLMEvent)
        .find((e): e is Extract<VernLLMEvent, { kind: 'retry' }> => e.kind === 'retry');

      if (!retryEvent) throw new Error('expected a "retry" event to have fired');
      return retryEvent.delayMs;
    } finally {
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  }

  it('a 429 waits longer than a 500, which waits longer than a 408', async () => {
    // baseDelayMs=200, attempt=1, exp = baseDelayMs * multiplier * 2:
    // default multiplier=1 -> exp=400, 5xx multiplier=1.5 -> exp=600,
    // 429 multiplier=2 -> exp=800. With Math.random pinned, delay =
    // FIXED_RANDOM * exp exactly, so this is an exact check, not a
    // statistical one.
    const delay429 = await backoffDelayFor(429);
    const delay500 = await backoffDelayFor(500);
    const delay408 = await backoffDelayFor(408);

    expect(delay429).toBeCloseTo(FIXED_RANDOM * 800);
    expect(delay500).toBeCloseTo(FIXED_RANDOM * 600);
    expect(delay408).toBeCloseTo(FIXED_RANDOM * 400);

    expect(delay429).toBeGreaterThan(delay500);
    expect(delay500).toBeGreaterThan(delay408);
  });

  it('a status of 600 or above is out of the 5xx range and keeps the default curve', async () => {
    // baseDelayMs=200, attempt=1: default exp=400, 5xx exp=600. A 600
    // status is above the valid HTTP status range entirely, so it must
    // not be treated as a server error and should land on the default
    // curve instead.
    const delay600 = await backoffDelayFor(600);
    const delay500 = await backoffDelayFor(500);

    expect(delay600).toBeCloseTo(FIXED_RANDOM * 400);
    expect(delay600).toBeLessThan(delay500);
  });
});

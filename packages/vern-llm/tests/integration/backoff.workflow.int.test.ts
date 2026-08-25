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
 */
describe('VernLLM workflow, status differentiated backoff', () => {
  /** One failed attempt against the given status, followed by a success. */
  async function backoffDelayFor(status: number): Promise<number> {
    vi.useFakeTimers();
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
      vi.useRealTimers();
    }
  }

  /** Averages several fake-timer runs to smooth out jitter, cheaply. */
  async function averageDelay(status: number, iterations = 30): Promise<number> {
    let total = 0;
    for (let i = 0; i < iterations; i++) {
      total += await backoffDelayFor(status);
    }
    return total / iterations;
  }

  it('a 429 waits longer than a 500, which waits longer than a 408', async () => {
    // baseDelayMs=200, attempt=1: default range [200, 400), 5xx range
    // [300, 600), 429 range [400, 800).
    const avg429 = await averageDelay(429);
    const avg500 = await averageDelay(500);
    const avg408 = await averageDelay(408);

    expect(avg429).toBeGreaterThan(avg500);
    expect(avg500).toBeGreaterThan(avg408);
  });
});

import { afterEach, describe, expect, it } from 'vitest';

import { fromFetch } from '../../../../src/adapters/fetch.js';
import { type WireStreamChunk } from '../../../../src/types/index.js';
import { VernLLM } from '../../../../src/vernLLM.js';
import { startRealSdkServer, type RealSdkServer } from '../../../realSdkServer.js';

/**
 * Regression coverage for `executeStreamCall`'s stream-opening path:
 * before this fix, a 429 on the very first `streamIterator.next()` (the
 * stream never even opens) never reached `reactToRateLimitError`, so
 * AIMD's ceiling stayed unchanged for streaming calls even though the
 * exact same failure on a non-streaming call already shrank it (see
 * `fetch.aimd.int.test.ts`'s "a real 429 shrinks the ceiling reactively"
 * case). This mirrors that test, but with `stream: true`.
 */
function mapStreamEvent(event: unknown): WireStreamChunk | undefined {
  const e = event as { delta?: string };
  return e.delta ? { type: 'text-delta', delta: e.delta } : undefined;
}

const SETTLE_WINDOW_MS = 150;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildClient(server: RealSdkServer) {
  return fromFetch({
    url: `${server.url}/chat`,
    mapRequest: (params) => ({ messages: params.messages }),
    mapResponse: (json) => ({ content: (json as { content: string }).content }),
    mapStreamEvent,
  });
}

describe('AIMD integration (real fromFetch, streaming), stream-open 429', () => {
  let server: RealSdkServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('a 429 on the streaming attempt that never opens still shrinks the ceiling reactively', async () => {
    server = await startRealSdkServer([
      {
        status: 429,
        headers: { 'x-ratelimit-remaining-requests': '0' },
        body: { error: 'rate limited' },
      },
    ]);

    const llm = new VernLLM({
      client: buildClient(server),
      model: 'custom',
      maxRetries: 0,
      rateLimit: {
        requestsPerMinute: 2,
        aimd: { increaseBy: 0, decreaseFactor: 0.0001, minCapacity: 0, maxCapacity: 100 },
      },
    });

    await expect(
      llm.call({ userContent: 'one', jsonMode: false, stream: true }),
    ).rejects.toMatchObject({ code: 'provider_rate_limited' });
    expect(server.requests).toHaveLength(1);

    // The ceiling should now be shrunk to (near) 0: a second call, still
    // non-streaming this time, should never reach the mock server since
    // it's blocked queueing for capacity.
    const controller = new AbortController();
    void llm
      .call({ userContent: 'two', jsonMode: false, signal: controller.signal })
      .catch(() => {});

    await sleep(SETTLE_WINDOW_MS);

    expect(server.requests).toHaveLength(1); // blocked: never reached the mock server

    controller.abort();
  });
});

import { afterEach, describe, expect, it } from 'vitest';

import { fromFetch } from '../../../../src/adapters/fetch.js';
import { type WireStreamChunk } from '../../../../src/types/index.js';
import { VernLLM } from '../../../../src/vernLLM.js';
import { sseRaw, startRealSdkServer, type RealSdkServer } from '../../../realSdkServer.js';

/**
 * Regression coverage for AIMD on `fromFetch`'s streaming path,
 * covering both directions:
 *
 * 1. Reactive: before this fix, a 429 on the very first
 *    `streamIterator.next()` (the stream never even opens) never
 *    reached `reactToRateLimitError`, so AIMD's ceiling stayed
 *    unchanged for streaming calls even though the exact same failure
 *    on a non-streaming call already shrank it (see
 *    `fetch.aimd.int.test.ts`'s "a real 429 shrinks the ceiling
 *    reactively" case). This mirrors that test, but with `stream: true`.
 *
 * 2. Proactive: before this fix, `createStream` never read the response
 *    headers at all (only `create`, the non-streaming path, did), so a
 *    streaming response's rate-limit headers were silently ignored, no
 *    `supportsWithResponse`-style opt-in needed here since `fromFetch`
 *    already has the headers in hand either way (native `fetch`'s
 *    `Response`), unlike the SDK-wrapping adapters.
 *
 * `aimd.minCapacity` must be `>= 1` (see `rateLimit.ts`'s own
 * `buildAimdOptions` comment), so a shrink to that floor never destroys
 * capacity already banked below it, only clamps it down. Proving the
 * shrink actually happened therefore takes two calls after it, not one:
 * the first spends the one unit of capacity still banked under the new,
 * lower ceiling (succeeding either way, shrunk or not); only the second
 * is the real discriminator, since it only blocks if the ceiling is
 * genuinely capped at 1 now, not whatever headroom `requestsPerMinute`
 * originally left.
 */
function completionBody(tag: string) {
  return { content: `ok:${tag}` };
}

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

describe('AIMD integration (real fromFetch, streaming)', () => {
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
      { body: completionBody('2') },
    ]);

    const llm = new VernLLM({
      client: buildClient(server),
      model: 'custom',
      maxRetries: 0,
      rateLimit: {
        requestsPerMinute: 5,
        aimd: { increaseBy: 0, decreaseFactor: 0.0001, minCapacity: 1, maxCapacity: 100 },
      },
    });

    // The failed stream-open attempt still spends 1 (acquire spends
    // unconditionally, before dispatch), leaving 4 of the original 5
    // banked, then the reactive shrink caps the ceiling at 1, clamping
    // that 4 down to 1, not below.
    await expect(
      llm.call({ userContent: 'one', jsonMode: false, stream: true }),
    ).rejects.toMatchObject({ code: 'provider_rate_limited' });
    expect(server.requests).toHaveLength(1);

    // Spends the one remaining banked unit (non-streaming this time;
    // AIMD's ceiling is adapter/mode-agnostic). Succeeds either way,
    // shrunk or not, so this alone doesn't prove anything.
    const second = await llm.call({ userContent: 'two', jsonMode: false });
    expect(second).toBe('ok:2');
    expect(server.requests).toHaveLength(2);

    // The real discriminator: blocked only if the ceiling is genuinely
    // capped at 1 now. Without the stream-open 429 reaching
    // `reactToRateLimitError`, 2 more units of the original 5 would
    // still be free, and this would succeed instead.
    const controller = new AbortController();
    void llm
      .call({ userContent: 'three', jsonMode: false, signal: controller.signal })
      .catch(() => {});

    await sleep(SETTLE_WINDOW_MS);

    expect(server.requests).toHaveLength(2); // blocked: never reached the mock server

    controller.abort();
  });

  it('a low remaining-requests header on a streaming response shrinks the ceiling proactively', async () => {
    server = await startRealSdkServer([
      {
        raw: sseRaw([{ data: { delta: 'ok:1' } }], {
          'x-ratelimit-remaining-requests': '1',
        }),
      },
      { body: completionBody('2') },
    ]);

    const llm = new VernLLM({
      client: buildClient(server),
      model: 'custom',
      rateLimit: {
        requestsPerMinute: 5,
        aimd: {
          increaseBy: 0,
          decreaseFactor: 0.0001,
          minCapacity: 1,
          maxCapacity: 100,
          proactiveFloor: 5,
        },
      },
    });

    // `fromFetch`'s default `requestStream` (native `fetch`) parses the
    // response header directly, no `stream: true`-only opt-in needed;
    // triggers the proactive shrink: capacity 5 -> floor 1, clamping the
    // 4 units already banked down to 1, not below.
    const first = await llm.call({ userContent: 'one', jsonMode: false, stream: true });
    for await (const _chunk of first.chunks) {
      // drain
    }
    await expect(first.finalResult).resolves.toBe('ok:1');
    expect(server.requests).toHaveLength(1);

    // Spends the one remaining banked unit (non-streaming this time;
    // AIMD's ceiling is adapter/mode-agnostic). Succeeds either way,
    // shrunk or not, so this alone doesn't prove anything.
    const second = await llm.call({ userContent: 'two', jsonMode: false });
    expect(second).toBe('ok:2');
    expect(server.requests).toHaveLength(2);

    // The real discriminator: blocked only if the ceiling is genuinely
    // capped at 1 now. If the streaming response's header were never
    // parsed at all, 2 more units of the original 5 would still be
    // free, and this would succeed instead.
    const controller = new AbortController();
    void llm
      .call({ userContent: 'three', jsonMode: false, signal: controller.signal })
      .catch(() => {});

    await sleep(SETTLE_WINDOW_MS);

    expect(server.requests).toHaveLength(2); // blocked: never reached the mock server

    controller.abort();
  });
});

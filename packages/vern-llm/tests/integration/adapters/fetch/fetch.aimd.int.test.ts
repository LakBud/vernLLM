import { afterEach, describe, expect, it } from 'vitest';

import { fromFetch } from '../../../../src/adapters/fetch.js';
import { VernLLM } from '../../../../src/vernLLM.js';
import { startRealSdkServer, type RealSdkServer } from '../../../realSdkServer.js';

/**
 * `fromFetch` counterpart to the openai/anthropic AIMD real-SDK tests.
 * Uses `startRealSdkServer` and real, unstubbed native `fetch` (not
 * `vi.stubGlobal('fetch', ...)`, unlike `fetch.int.test.ts`), the same
 * reasoning as those files: proving `res.headers.get()` really works
 * against a real Fetch `Response`, not a hand-rolled object that merely
 * matches `ResponseLike`'s shape. `fromFetch` has no gating flag to test
 * here (unlike `supportsWithResponse`): header parsing is on by default,
 * since the response headers are already in hand either way, see
 * `parseRateLimitHint`'s own doc comment on `FetchAdapterConfig`.
 *
 * `aimd.minCapacity` must be `>= 1` (the requests bucket always takes
 * exactly 1 per acquire, so a lower ceiling could never be satisfied).
 * A shrink to that floor is therefore never destructive to capacity
 * already banked below it: `resize()` only clamps `available` down to
 * the new ceiling, never below what was already unspent. So proving a
 * shrink actually happened takes two calls after it, not one: the
 * first spends the one unit of capacity still banked under the new,
 * lower ceiling (succeeding either way, shrunk or not), and only the
 * second is the real discriminator, since it only blocks if the
 * ceiling is genuinely capped at 1 now, not whatever headroom
 * `requestsPerMinute` originally left.
 */
function completionBody(tag: string) {
  return { content: `ok:${tag}` };
}

const SETTLE_WINDOW_MS = 150;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildClient(
  server: RealSdkServer,
  overrides: Partial<Pick<Parameters<typeof fromFetch>[0], 'parseRateLimitHint'>> = {},
) {
  return fromFetch({
    url: `${server.url}/chat`,
    mapRequest: (params) => ({ messages: params.messages }),
    mapResponse: (json) => ({ content: (json as { content: string }).content }),
    ...overrides,
  });
}

describe('AIMD integration (real fromFetch, unstubbed fetch)', () => {
  let server: RealSdkServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('shrinks the ceiling proactively off the default OpenAI-shaped header, no opt-in needed', async () => {
    server = await startRealSdkServer([
      { body: completionBody('1'), headers: { 'x-ratelimit-remaining-requests': '1' } },
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

    // Triggers the proactive shrink: capacity 5 -> floor 1. `available`
    // was 4 before the shrink (only 1 spent so far), clamped down to
    // the new ceiling of 1, not destroyed.
    const first = await llm.call({ userContent: 'one', jsonMode: false });
    expect(first).toBe('ok:1');
    expect(server.requests).toHaveLength(1);

    // Spends that one remaining unit of banked capacity. Succeeds
    // whether or not the shrink actually happened (it's within the
    // original headroom either way), so this call alone doesn't prove
    // anything; it's the setup for the real assertion below.
    const second = await llm.call({ userContent: 'two', jsonMode: false });
    expect(second).toBe('ok:2');
    expect(server.requests).toHaveLength(2);

    // The real discriminator: with the shrink applied, capacity is
    // genuinely capped at 1 now, so a third call blocks. Without it,
    // capacity would still be 5 with 3 units of headroom left, and
    // this would succeed immediately instead.
    const controller = new AbortController();
    void llm
      .call({ userContent: 'three', jsonMode: false, signal: controller.signal })
      .catch(() => {});

    await sleep(SETTLE_WINDOW_MS);

    expect(server.requests).toHaveLength(2); // blocked: never reached the mock server

    controller.abort();
  });

  it('a custom parseRateLimitHint overrides the default OpenAI-shaped parser', async () => {
    server = await startRealSdkServer([
      // A non-OpenAI-shaped header set the default parser wouldn't recognize.
      { body: completionBody('1'), headers: { 'x-custom-remaining': '1' } },
      { body: completionBody('2') },
    ]);

    const llm = new VernLLM({
      client: buildClient(server, {
        parseRateLimitHint: (headers: { get(name: string): string | null }) => ({
          remainingRequests: Number(headers.get('x-custom-remaining') ?? undefined),
        }),
      }),
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

    const first = await llm.call({ userContent: 'one', jsonMode: false });
    expect(first).toBe('ok:1');

    const second = await llm.call({ userContent: 'two', jsonMode: false });
    expect(second).toBe('ok:2');
    expect(server.requests).toHaveLength(2);

    const controller = new AbortController();
    void llm
      .call({ userContent: 'three', jsonMode: false, signal: controller.signal })
      .catch(() => {});

    await sleep(SETTLE_WINDOW_MS);

    expect(server.requests).toHaveLength(2); // the custom parser's hint drove the shrink

    controller.abort();
  });

  it("a response with none of the recognized headers leaves AIMD's ceiling untouched", async () => {
    server = await startRealSdkServer([
      { body: completionBody('1') },
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

    const first = await llm.call({ userContent: 'one', jsonMode: false });
    expect(first).toBe('ok:1');

    const second = await llm.call({ userContent: 'two', jsonMode: false });
    expect(second).toBe('ok:2');
    expect(server.requests).toHaveLength(2);
  });

  it('a real 429 shrinks the ceiling reactively, off the error path VernLLM already attaches headers to', async () => {
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

    // The failed attempt still spends 1 from the requests bucket
    // (acquire spends unconditionally, before dispatch), leaving 4 of
    // the original 5 banked. The reactive shrink then caps the ceiling
    // at 1, clamping that 4 down to 1, not below.
    await expect(llm.call({ userContent: 'one', jsonMode: false })).rejects.toMatchObject({
      code: 'provider_rate_limited',
    });
    expect(server.requests).toHaveLength(1);

    // Spends the one remaining banked unit. Succeeds either way, shrunk
    // or not, so this alone doesn't prove the shrink happened.
    const second = await llm.call({ userContent: 'two', jsonMode: false });
    expect(second).toBe('ok:2');
    expect(server.requests).toHaveLength(2);

    // The real discriminator: blocked only if the ceiling is genuinely
    // capped at 1 now. Without the shrink, 2 more units of the original
    // 5 would still be free, and this would succeed instead.
    const controller = new AbortController();
    void llm
      .call({ userContent: 'three', jsonMode: false, signal: controller.signal })
      .catch(() => {});

    await sleep(SETTLE_WINDOW_MS);

    expect(server.requests).toHaveLength(2); // blocked: never reached the mock server

    controller.abort();
  });
});

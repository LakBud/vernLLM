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
          minCapacity: 0,
          maxCapacity: 100,
          proactiveFloor: 5,
        },
      },
    });

    const first = await llm.call({ userContent: 'one', jsonMode: false });
    expect(first).toBe('ok:1');
    expect(server.requests).toHaveLength(1);

    const controller = new AbortController();
    void llm
      .call({ userContent: 'two', jsonMode: false, signal: controller.signal })
      .catch(() => {});

    await sleep(SETTLE_WINDOW_MS);

    expect(server.requests).toHaveLength(1); // blocked: never reached the mock server

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
          minCapacity: 0,
          maxCapacity: 100,
          proactiveFloor: 5,
        },
      },
    });

    const first = await llm.call({ userContent: 'one', jsonMode: false });
    expect(first).toBe('ok:1');

    const controller = new AbortController();
    void llm
      .call({ userContent: 'two', jsonMode: false, signal: controller.signal })
      .catch(() => {});

    await sleep(SETTLE_WINDOW_MS);

    expect(server.requests).toHaveLength(1); // the custom parser's hint drove the shrink

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
          minCapacity: 0,
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
        requestsPerMinute: 2,
        aimd: { increaseBy: 0, decreaseFactor: 0.0001, minCapacity: 0, maxCapacity: 100 },
      },
    });

    await expect(llm.call({ userContent: 'one', jsonMode: false })).rejects.toMatchObject({
      code: 'provider_rate_limited',
    });
    expect(server.requests).toHaveLength(1);

    const controller = new AbortController();
    void llm
      .call({ userContent: 'two', jsonMode: false, signal: controller.signal })
      .catch(() => {});

    await sleep(SETTLE_WINDOW_MS);

    expect(server.requests).toHaveLength(1); // blocked: never reached the mock server

    controller.abort();
  });
});

import OpenAI from 'openai';
import { afterEach, describe, expect, it } from 'vitest';

import { fromOpenAI } from '../../../../src/adapters/openaiCompatible.js';
import { VernLLM } from '../../../../src/vernLLM.js';
import { sseRaw, startRealSdkServer, type RealSdkServer } from '../../../realSdkServer.js';

/**
 * Exercises AIMD's proactive and reactive paths against a real `openai`
 * SDK client, pointed at a local mock server. Confirmed real, not just
 * asserted from documentation, per the AIMD design plan's own fact-check
 * against the SDK's source: `.withResponse()` is a chainable method on
 * the same `APIPromise` `create()` already returns, and a thrown
 * `RateLimitError` already carries `.headers`, both exercised here end
 * to end rather than assumed.
 *
 * A call blocked by the rate limiter never even reaches `client.chat
 * .completions.create()` (`RateLimiter.acquire()` awaits capacity
 * first), so whether the *next* call actually landed on the mock
 * server after a short real wait is a reliable, adapter-agnostic signal
 * of "did AIMD's shrink actually take effect". A plain pending-promise
 * check (flushing microtasks with nothing awaited) does not work here:
 * a real loopback HTTP round trip does not settle within pure
 * microtasks either way, rate-limited or not, so it reads as "pending"
 * regardless and can't tell the two apart.
 *
 * `aimd.minCapacity` must be `>= 1` (the requests bucket always takes
 * exactly 1 per acquire, so a lower ceiling could never be satisfied,
 * and letting it reach exactly 0 would permanently break the bucket's
 * refill rate too, see `rateLimit.ts`'s own `buildAimdOptions` comment).
 * A shrink to that floor therefore never destroys capacity already
 * banked below it, only clamps it down: proving a shrink actually took
 * effect takes two calls after it, not one. The first spends whatever
 * single unit of capacity is still banked under the new, lower ceiling
 * (succeeding either way, shrunk or not); only the second call is the
 * real discriminator, since it only blocks if the ceiling is genuinely
 * capped at 1 now, not whatever headroom `requestsPerMinute` originally
 * left.
 */
function completionBody(tag: string) {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    model: 'gpt-test',
    choices: [
      { index: 0, message: { role: 'assistant', content: `ok:${tag}` }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  };
}

/** A minimal, single-chunk real OpenAI SSE stream (one delta, then `finish_reason`, then `[DONE]`). */
function streamedCompletion(tag: string, headers?: Record<string, string>) {
  return sseRaw(
    [
      {
        data: {
          id: 'chatcmpl-1',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { role: 'assistant', content: `ok:${tag}` } }],
        },
      },
      {
        data: {
          id: 'chatcmpl-1',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        },
      },
      { data: '[DONE]' },
    ],
    headers,
  );
}

/** Comfortably longer than a loopback round trip, comfortably shorter than any queue/backoff wait in these tests. */
const SETTLE_WINDOW_MS = 150;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('AIMD integration (real openai SDK client)', () => {
  let server: RealSdkServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('supportsWithResponse: true shrinks the ceiling proactively off a low remaining-requests header', async () => {
    server = await startRealSdkServer([
      { body: completionBody('1'), headers: { 'x-ratelimit-remaining-requests': '1' } },
      { body: completionBody('2') },
    ]);

    const openai = new OpenAI({ apiKey: 'test-key', baseURL: `${server.url}/v1` });

    const llm = new VernLLM({
      client: fromOpenAI(openai, { supportsWithResponse: true }),
      model: 'gpt-test',
      rateLimit: {
        requestsPerMinute: 5,
        // decreaseFactor deliberately tiny: drives the shrink straight
        // down to minCapacity (1), the floor a caller could ever
        // configure, rather than some intermediate value.
        aimd: {
          increaseBy: 0,
          decreaseFactor: 0.0001,
          minCapacity: 1,
          maxCapacity: 100,
          proactiveFloor: 5,
        },
      },
    });

    // Triggers the proactive shrink: capacity 5 -> floor 1, clamping
    // the 4 units already banked down to 1, not below.
    const first = await llm.call({ userContent: 'one', jsonMode: false });
    expect(first).toBe('ok:1');
    expect(server.requests).toHaveLength(1);

    // Spends the one remaining banked unit. Succeeds either way, shrunk
    // or not, so this alone doesn't prove anything; it's the setup for
    // the real assertion below.
    const second = await llm.call({ userContent: 'two', jsonMode: false });
    expect(second).toBe('ok:2');
    expect(server.requests).toHaveLength(2);

    // The real discriminator: blocked only if the ceiling is genuinely
    // capped at 1 now. Without the shrink, 2 more units of the original
    // 5 would still be free, and this would succeed instead.
    const controller = new AbortController();
    void llm
      .call({ userContent: 'three', jsonMode: false, signal: controller.signal })
      .catch(() => {}); // aborted below; the rejection itself isn't the assertion

    await sleep(SETTLE_WINDOW_MS);

    // Blocked in the limiter's queue: never reached the mock server.
    expect(server.requests).toHaveLength(2);

    controller.abort();
  });

  it('supportsWithResponse left at default (false) ignores the same header, no proactive shrink', async () => {
    server = await startRealSdkServer([
      { body: completionBody('1'), headers: { 'x-ratelimit-remaining-requests': '1' } },
      { body: completionBody('2') },
    ]);

    const openai = new OpenAI({ apiKey: 'test-key', baseURL: `${server.url}/v1` });

    const llm = new VernLLM({
      client: fromOpenAI(openai), // supportsWithResponse defaults false
      model: 'gpt-test',
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

    // Ceiling never shrank (the header was never read): the second call
    // reaches the server and succeeds normally.
    const second = await llm.call({ userContent: 'two', jsonMode: false });
    expect(second).toBe('ok:2');
    expect(server.requests).toHaveLength(2);
  });

  it('a real 429 shrinks the ceiling reactively, independent of supportsWithResponse', async () => {
    server = await startRealSdkServer([
      {
        status: 429,
        headers: { 'x-ratelimit-remaining-requests': '0' },
        body: { error: { message: 'rate limited', type: 'rate_limit_exceeded' } },
      },
      { body: completionBody('2') },
    ]);

    const openai = new OpenAI({ apiKey: 'test-key', baseURL: `${server.url}/v1`, maxRetries: 0 });

    const llm = new VernLLM({
      client: fromOpenAI(openai), // supportsWithResponse false: proves the reactive path doesn't need it
      model: 'gpt-test',
      maxRetries: 0,
      rateLimit: {
        requestsPerMinute: 5,
        aimd: { increaseBy: 0, decreaseFactor: 0.0001, minCapacity: 1, maxCapacity: 100 },
      },
    });

    // The failed attempt still spends 1 (acquire spends unconditionally,
    // before dispatch), leaving 4 of the original 5 banked, then the
    // reactive shrink caps the ceiling at 1, clamping that 4 down to 1.
    await expect(llm.call({ userContent: 'one', jsonMode: false })).rejects.toMatchObject({
      code: 'provider_rate_limited',
    });
    expect(server.requests).toHaveLength(1);

    // Spends the one remaining banked unit.
    const second = await llm.call({ userContent: 'two', jsonMode: false });
    expect(second).toBe('ok:2');
    expect(server.requests).toHaveLength(2);

    const controller = new AbortController();
    void llm
      .call({ userContent: 'three', jsonMode: false, signal: controller.signal })
      .catch(() => {});

    await sleep(SETTLE_WINDOW_MS);

    // Ceiling shrank off the 429 alone (no header parsing needed for
    // this): the third call is blocked in the queue, never reaching
    // the server.
    expect(server.requests).toHaveLength(2);

    controller.abort();
  });

  it('supportsWithResponse: true shrinks the ceiling proactively for a streaming call too', async () => {
    server = await startRealSdkServer([
      { raw: streamedCompletion('1', { 'x-ratelimit-remaining-requests': '1' }) },
      { body: completionBody('2') },
    ]);

    const openai = new OpenAI({ apiKey: 'test-key', baseURL: `${server.url}/v1` });

    const llm = new VernLLM({
      client: fromOpenAI(openai, { supportsWithResponse: true }),
      model: 'gpt-test',
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

    // Streams a real response; the low-remaining-requests header on it
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

  it('supportsWithResponse left at default (false) never parses streaming headers, even with a low-remaining header present', async () => {
    server = await startRealSdkServer([
      { raw: streamedCompletion('1', { 'x-ratelimit-remaining-requests': '1' }) },
      { body: completionBody('2') },
    ]);

    const openai = new OpenAI({ apiKey: 'test-key', baseURL: `${server.url}/v1` });

    const llm = new VernLLM({
      client: fromOpenAI(openai), // supportsWithResponse defaults false
      model: 'gpt-test',
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

    const first = await llm.call({ userContent: 'one', jsonMode: false, stream: true });
    for await (const _chunk of first.chunks) {
      // drain
    }
    await expect(first.finalResult).resolves.toBe('ok:1');

    // Ceiling never shrank (the header was never read): the second call
    // reaches the server and succeeds normally.
    const second = await llm.call({ userContent: 'two', jsonMode: false });
    expect(second).toBe('ok:2');
    expect(server.requests).toHaveLength(2);
  });
});

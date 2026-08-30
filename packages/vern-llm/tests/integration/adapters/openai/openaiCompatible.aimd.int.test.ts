import OpenAI from 'openai';
import { afterEach, describe, expect, it } from 'vitest';

import { fromOpenAI } from '../../../../src/adapters/openaiCompatible.js';
import { VernLLM } from '../../../../src/vernLLM.js';
import { startRealSdkServer, type RealSdkServer } from '../../../realSdkServer.js';

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
 * first), so whether the *second* call actually landed on the mock
 * server after a short real wait is a reliable, adapter-agnostic signal
 * of "did AIMD's shrink actually take effect". A plain pending-promise
 * check (flushing microtasks with nothing awaited) does not work here:
 * a real loopback HTTP round trip does not settle within pure
 * microtasks either way, rate-limited or not, so it reads as "pending"
 * regardless and can't tell the two apart.
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
        // decreaseFactor deliberately tiny: clamps available well under
        // 1 after the shrink, guaranteeing the very next call blocks
        // rather than one more full unit slipping through first.
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
      .catch(() => {}); // aborted below; the rejection itself isn't the assertion

    await sleep(SETTLE_WINDOW_MS);

    // Blocked in the limiter's queue: never reached the mock server.
    expect(server.requests).toHaveLength(1);

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
          minCapacity: 0,
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

    // Ceiling shrank off the 429 alone (no header parsing needed for
    // this): the second call is blocked in the queue, never reaching
    // the server.
    expect(server.requests).toHaveLength(1);

    controller.abort();
  });
});

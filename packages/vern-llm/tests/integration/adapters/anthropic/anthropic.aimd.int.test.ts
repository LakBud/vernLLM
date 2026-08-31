import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { fromAnthropic } from '../../../../src/adapters/anthropic.js';
import { VernLLM } from '../../../../src/vernLLM.js';
import { sseRaw, startRealSdkServer, type RealSdkServer } from '../../../realSdkServer.js';

/**
 * Anthropic counterpart to `openaiCompatible.aimd.real.int.test.ts`. See
 * that file's own header comment for why a request-reached-the-server
 * check, not a pending-promise check, is what actually distinguishes
 * "blocked by AIMD" from "still in flight over a real socket" here, and
 * for why proving a shrink happened takes two calls after it (spend the
 * banked slack, then check the next one is genuinely capped), not one.
 */
function messageBody(tag: string) {
  return {
    id: 'msg_01',
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    content: [{ type: 'text', text: `ok:${tag}` }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 4 },
  };
}

/** A minimal, single-chunk real Anthropic SSE stream. */
function streamedMessage(tag: string, headers?: Record<string, string>) {
  return sseRaw(
    [
      {
        event: 'message_start',
        data: { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      },
      {
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: `ok:${tag}` },
        },
      },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { event: 'message_delta', data: { type: 'message_delta', usage: { output_tokens: 4 } } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ],
    headers,
  );
}

const SETTLE_WINDOW_MS = 150;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('AIMD integration (real @anthropic-ai/sdk client)', () => {
  let server: RealSdkServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('supportsWithResponse: true shrinks the ceiling proactively off a low remaining-requests header', async () => {
    server = await startRealSdkServer([
      {
        body: messageBody('1'),
        headers: { 'anthropic-ratelimit-requests-remaining': '1' },
      },
      { body: messageBody('2') },
    ]);

    const anthropic = new Anthropic({ apiKey: 'test-key', baseURL: server.url });

    const llm = new VernLLM({
      client: fromAnthropic(anthropic, { supportsWithResponse: true }),
      model: 'claude-test',
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

    // Triggers the proactive shrink: capacity 5 -> floor 1, clamping
    // the 4 units already banked down to 1, not below.
    const first = await llm.call({ userContent: 'one', jsonMode: false });
    expect(first).toBe('ok:1');
    expect(server.requests).toHaveLength(1);

    // Spends that one remaining banked unit. Succeeds either way,
    // shrunk or not; the real assertion is the third call below.
    const second = await llm.call({ userContent: 'two', jsonMode: false });
    expect(second).toBe('ok:2');
    expect(server.requests).toHaveLength(2);

    const controller = new AbortController();
    void llm
      .call({ userContent: 'three', jsonMode: false, signal: controller.signal })
      .catch(() => {});

    await sleep(SETTLE_WINDOW_MS);

    expect(server.requests).toHaveLength(2); // blocked: never reached the mock server

    controller.abort();
  });

  it('supportsWithResponse left at default (false) ignores the same header, no proactive shrink', async () => {
    server = await startRealSdkServer([
      {
        body: messageBody('1'),
        headers: { 'anthropic-ratelimit-requests-remaining': '1' },
      },
      { body: messageBody('2') },
    ]);

    const anthropic = new Anthropic({ apiKey: 'test-key', baseURL: server.url });

    const llm = new VernLLM({
      client: fromAnthropic(anthropic), // supportsWithResponse defaults false
      model: 'claude-test',
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

  it('a real 429 shrinks the ceiling reactively, independent of supportsWithResponse', async () => {
    server = await startRealSdkServer([
      {
        status: 429,
        headers: { 'anthropic-ratelimit-requests-remaining': '0' },
        body: { type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } },
      },
      { body: messageBody('2') },
    ]);

    // maxRetries: 0 on the SDK client itself: the real Anthropic SDK
    // retries a 429 internally by default (maxRetries: 2), which would
    // silently absorb it using both scripted responses inside one
    // `create()` call, never giving VernLLM's own reactive path
    // anything to react to.
    const anthropic = new Anthropic({ apiKey: 'test-key', baseURL: server.url, maxRetries: 0 });

    const llm = new VernLLM({
      client: fromAnthropic(anthropic), // supportsWithResponse false: proves the reactive path doesn't need it
      model: 'claude-test',
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

    expect(server.requests).toHaveLength(2); // blocked: never reached the mock server

    controller.abort();
  });

  it('supportsWithResponse: true shrinks the ceiling proactively for a streaming call too', async () => {
    server = await startRealSdkServer([
      { raw: streamedMessage('1', { 'anthropic-ratelimit-requests-remaining': '1' }) },
      { body: messageBody('2') },
    ]);

    const anthropic = new Anthropic({ apiKey: 'test-key', baseURL: server.url });

    const llm = new VernLLM({
      client: fromAnthropic(anthropic, { supportsWithResponse: true }),
      model: 'claude-test',
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
      { raw: streamedMessage('1', { 'anthropic-ratelimit-requests-remaining': '1' }) },
      { body: messageBody('2') },
    ]);

    const anthropic = new Anthropic({ apiKey: 'test-key', baseURL: server.url });

    const llm = new VernLLM({
      client: fromAnthropic(anthropic), // supportsWithResponse defaults false
      model: 'claude-test',
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

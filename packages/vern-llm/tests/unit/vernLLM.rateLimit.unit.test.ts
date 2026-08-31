import { describe, it, expect, vi } from 'vitest';

import { VernLLM } from '../../src/vernLLM.js';
import {
  createMockClient,
  createMockStreamingClient,
  drain,
  jsonResponse,
  textResponse,
} from './../helpers.js';

import type { VernLLMEvent, WireStreamChunk } from '../../src/types/index.js';

describe('VernLLM, rateLimit option', () => {
  it('no rateLimit configured means zero behavioural change', async () => {
    const { client } = createMockClient([jsonResponse({ ok: true })]);
    const llm = new VernLLM({ client, model: 'gpt-4o' });

    const result = await llm.call<{ ok: boolean }>({ userContent: 'hi' });
    expect(result).toEqual({ ok: true });
  });

  it('queues a second concurrent call behind maxConcurrent: 1 and fires a rate_limited event', async () => {
    let resolveFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });

    const { client } = createMockClient([
      async () => {
        await gate;
        return jsonResponse({ n: 1 });
      },
      jsonResponse({ n: 2 }),
    ]);

    const events: VernLLMEvent[] = [];

    const llm = new VernLLM({
      client,
      model: 'gpt-4o',
      rateLimit: { maxConcurrent: 1, maxQueueMs: 0 },
      onEvent: (event) => events.push(event),
    });

    const first = llm.call<{ n: number }>({ userContent: 'one' });

    // Give the first call's mock a moment to actually start (and thereby
    // hold the only concurrency slot) before firing the second.
    await new Promise((r) => setTimeout(r, 10));

    const second = llm.call<{ n: number }>({ userContent: 'two' });

    await new Promise((r) => setTimeout(r, 10));
    resolveFirst();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual({ n: 1 });
    expect(secondResult).toEqual({ n: 2 });

    const rateLimited = events.filter((e) => e.kind === 'rate_limited');
    expect(rateLimited.length).toBeGreaterThan(0);
    expect(rateLimited[0]).toMatchObject({ provider: 'primary', reason: 'concurrency' });
  });

  it('a queued call rejects with a rate_limit_queue_timeout-coded rate_limited error on maxQueueMs', async () => {
    let resolveFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });

    const { client } = createMockClient([
      async () => {
        await gate;
        return jsonResponse({ n: 1 });
      },
      jsonResponse({ n: 2 }),
    ]);

    const llm = new VernLLM({
      client,
      model: 'gpt-4o',
      maxRetries: 0,
      rateLimit: { maxConcurrent: 1, maxQueueMs: 20 },
    });

    const first = llm.call<{ n: number }>({ userContent: 'one' });
    await new Promise((r) => setTimeout(r, 5));

    await expect(llm.call<{ n: number }>({ userContent: 'two' })).rejects.toMatchObject({
      type: 'rate_limited',
      code: 'rate_limit_queue_timeout',
    });

    resolveFirst();
    await first;
  });

  it('stream: true holds its concurrency slot until completion, then releases it for a queued call', async () => {
    let releaseFirstChunk!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirstChunk = resolve;
    });

    const gatedStream = async function* (): AsyncGenerator<WireStreamChunk> {
      await gate;
      yield { type: 'text-delta', delta: 'one' };
      yield { type: 'usage', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    };

    const { client, calls } = createMockStreamingClient([
      () => gatedStream(),
      [
        { type: 'text-delta', delta: 'two' },
        { type: 'usage', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
      ],
    ]);

    const llm = new VernLLM({
      client,
      model: 'gpt-4o',
      rateLimit: { maxConcurrent: 1, maxQueueMs: 0 },
    });

    const first = llm.call({ userContent: 'one', jsonMode: false, stream: true });

    // `createStream` is only invoked after the concurrency slot is
    // successfully acquired (see `executeStreamCall`), so this is a
    // deterministic signal that the first call now holds the only slot,
    // unlike a fixed sleep that just hopes enough time has passed.
    await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(1));

    let secondSettled = false;
    const second = llm.call({ userContent: 'two', jsonMode: false, stream: true }).then((r) => {
      secondSettled = true;
      return r;
    });

    await Promise.resolve();
    expect(secondSettled).toBe(false); // still queued: the first stream hasn't completed

    releaseFirstChunk();

    const firstResult = await first;
    await expect(firstResult.finalResult).resolves.toBe('one');

    const secondResult = await second;
    expect(secondSettled).toBe(true);
    await expect(secondResult.finalResult).resolves.toBe('two');
  });

  it('a mid-stream failure still releases the concurrency slot for a queued call', async () => {
    let releaseFirstChunk!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirstChunk = resolve;
    });

    const failingStream = async function* (): AsyncGenerator<WireStreamChunk> {
      yield { type: 'text-delta', delta: 'partial' };
      await gate;
      throw new Error('connection dropped mid-stream');
    };

    const { client } = createMockStreamingClient([
      () => failingStream(),
      [{ type: 'text-delta', delta: 'two' }],
    ]);

    const llm = new VernLLM({
      client,
      model: 'gpt-4o',
      maxRetries: 0,
      rateLimit: { maxConcurrent: 1, maxQueueMs: 0 },
    });

    const first = await llm.call({ userContent: 'one', jsonMode: false, stream: true });
    // Drain the first chunk so the mock actually starts, matching how a
    // real caller would consume `chunks` alongside `finalResult`.
    void (async () => {
      try {
        for await (const _chunk of first.chunks) {
          // no-op: just pump the async generator
        }
      } catch {
        // The stream fails mid-way in this test; `finalResult` below is
        // what the test actually asserts on.
      }
    })();

    // No sleep needed here: `first` only resolved once its concurrency
    // slot was acquired (see `executeStreamCall`), and that slot isn't
    // released until the whole stream settles (`finish()`/`fail()` in
    // `buildStreamResult`), well after this point, so the slot is
    // already known to be held.
    let secondSettled = false;
    const second = llm.call({ userContent: 'two', jsonMode: false, stream: true }).then((r) => {
      secondSettled = true;
      return r;
    });

    await Promise.resolve();
    expect(secondSettled).toBe(false); // still queued: the first stream hasn't failed yet

    releaseFirstChunk();

    await expect(first.finalResult).rejects.toThrow();

    const secondResult = await second;
    expect(secondSettled).toBe(true);
    await expect(secondResult.finalResult).resolves.toBe('two');
  });

  describe('AIMD ceiling only grows on a response VernLLM actually accepts', () => {
    /**
     * Regression coverage: `growOnSuccess()` used to fire as soon as a
     * response arrived, before `finalizeResponse`/`detectSoftFailure`
     * had a chance to reject it (invalid JSON, schema/tool-contract
     * validation, empty content, a soft failure). A response VernLLM
     * itself rejects must never grow the ceiling.
     *
     * `requestsPerMinute: 1` deliberately drains `available` to exactly
     * 0 on the rejected call, so growth is the only thing that could
     * let a second call through sooner than a full refill would allow.
     * `increaseBy: 10` makes a wrongful grow impossible to miss: if it
     * fired, capacity would jump from 1 to 11, and a full-window
     * refill would leave 10 spare requests free instead of the single
     * one a correctly-ungrown ceiling allows.
     */
    const PLACEHOLDER = 'N/A';

    function flagPlaceholder(result: unknown) {
      return typeof result === 'string' && result.trim() === PLACEHOLDER
        ? 'empty_response'
        : undefined;
    }

    it('a non-streaming response rejected by detectSoftFailure does not grow the ceiling', async () => {
      vi.useFakeTimers();

      const { client, calls } = createMockClient([
        textResponse(PLACEHOLDER),
        jsonResponse({ n: 2 }),
        jsonResponse({ n: 3 }),
      ]);

      const llm = new VernLLM({
        client,
        model: 'gpt-4o',
        maxRetries: 0,
        detectSoftFailure: flagPlaceholder,
        rateLimit: {
          requestsPerMinute: 1,
          aimd: { increaseBy: 10, decreaseFactor: 1, minCapacity: 1, maxCapacity: 100 },
        },
      });

      // Rejected by the soft-failure hook. Drains `available` to 0
      // either way; a wrongful grow would additionally push capacity
      // from 1 to 11.
      await expect(llm.call({ userContent: 'one', jsonMode: false })).rejects.toMatchObject({
        code: 'empty_response',
      });

      // A full window's worth of refill: enough to fully restore
      // capacity 1 back to `available: 1` either way, but only enough
      // to restore capacity 11 back to `available: 11` in the buggy
      // case.
      await vi.advanceTimersByTimeAsync(60_000);

      // Succeeds either way: even a correctly-ungrown ceiling of 1 has
      // refilled to `available: 1` by now. This call alone doesn't
      // prove anything; it's the setup for the real assertion below.
      const second = await llm.call<{ n: number }>({ userContent: 'two' });
      expect(second).toEqual({ n: 2 });
      expect(calls).toHaveLength(2);

      // The real discriminator: with the ceiling correctly still at 1,
      // this stays queued, so the mock client is never actually
      // invoked a third time. If the ceiling had wrongly grown to 11,
      // there would still be 9 spare requests free and `create` would
      // be called immediately instead. A plain pending-promise check
      // isn't reliable here (the mock client resolves synchronously
      // with no real I/O, so the outer call promise can still be
      // mid-flight through unrelated internal `await`s several
      // microtask ticks later regardless of whether the limiter let it
      // through), so the call count is the actual signal, matching how
      // the real-SDK AIMD integration tests check `server.requests`.
      const controller = new AbortController();
      void llm
        .call({ userContent: 'three', jsonMode: false, signal: controller.signal })
        .catch(() => {});

      for (let i = 0; i < 5; i++) await Promise.resolve();

      expect(calls).toHaveLength(2);

      controller.abort();
    });

    it('a streaming response rejected by detectSoftFailure does not grow the ceiling', async () => {
      vi.useFakeTimers();

      const { client, calls } = createMockStreamingClient([
        [{ type: 'text-delta', delta: PLACEHOLDER }],
        [{ type: 'text-delta', delta: 'ok:2' }],
        [{ type: 'text-delta', delta: 'ok:3' }],
      ]);

      const llm = new VernLLM({
        client,
        model: 'gpt-4o',
        maxRetries: 0,
        detectSoftFailure: flagPlaceholder,
        rateLimit: {
          requestsPerMinute: 1,
          aimd: { increaseBy: 10, decreaseFactor: 1, minCapacity: 1, maxCapacity: 100 },
        },
      });

      const first = await llm.call({ userContent: 'one', jsonMode: false, stream: true });
      await drain(first.chunks);
      await expect(first.finalResult).rejects.toMatchObject({ code: 'empty_response' });

      await vi.advanceTimersByTimeAsync(60_000);

      const second = await llm.call({ userContent: 'two', jsonMode: false, stream: true });
      await drain(second.chunks);
      await expect(second.finalResult).resolves.toBe('ok:2');
      expect(calls).toHaveLength(2);

      const controller = new AbortController();
      void llm
        .call({ userContent: 'three', jsonMode: false, stream: true, signal: controller.signal })
        .catch(() => {});

      for (let i = 0; i < 5; i++) await Promise.resolve();

      expect(calls).toHaveLength(2);

      controller.abort();
    });
  });
});

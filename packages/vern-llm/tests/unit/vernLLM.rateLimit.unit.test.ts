import { describe, it, expect } from 'vitest';

import { VernLLM } from '../../src/vernLLM.js';
import { createMockClient, createMockStreamingClient, jsonResponse } from './../helpers.js';

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

  it('a queued call rejects with a local_rate_limit-coded quota_exceeded error on maxQueueMs', async () => {
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
      type: 'quota_exceeded',
      code: 'local_rate_limit',
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

    const { client } = createMockStreamingClient([
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

    // Give the first call a moment to actually open its stream (and
    // thereby hold the only concurrency slot) before firing the second.
    await new Promise((r) => setTimeout(r, 10));

    let secondSettled = false;
    const second = llm.call({ userContent: 'two', jsonMode: false, stream: true }).then((r) => {
      secondSettled = true;
      return r;
    });

    await new Promise((r) => setTimeout(r, 10));
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

    await new Promise((r) => setTimeout(r, 10));

    let secondSettled = false;
    const second = llm.call({ userContent: 'two', jsonMode: false, stream: true }).then((r) => {
      secondSettled = true;
      return r;
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(secondSettled).toBe(false); // still queued: the first stream hasn't failed yet

    releaseFirstChunk();

    await expect(first.finalResult).rejects.toThrow();

    const secondResult = await second;
    expect(secondSettled).toBe(true);
    await expect(secondResult.finalResult).resolves.toBe('two');
  });
});

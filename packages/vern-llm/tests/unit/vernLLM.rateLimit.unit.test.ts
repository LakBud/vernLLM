import { describe, it, expect } from 'vitest';

import { VernLLM } from '../../src/vernLLM.js';
import { createMockClient, jsonResponse } from './../helpers.js';

import type { VernLLMEvent } from '../../src/types/index.js';

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
});

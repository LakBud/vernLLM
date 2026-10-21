import { VernLLM, type WireStreamChunk } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { usageMiddleware } from '../../src/index.js';
import { createMockStreamingClient, daysAgo, spyStore } from '../helpers.js';

const prices = { 'gpt-6-sol': { input: 2, output: 10 } };
const spent = { prompt_tokens: 60, completion_tokens: 40, total_tokens: 100 };
const chunks: WireStreamChunk[] = [
  { type: 'text-delta', delta: 'hel' },
  { type: 'text-delta', delta: 'lo' },
  { type: 'usage', usage: spent },
];
const call = {
  userContent: 'hi',
  jsonMode: false as const,
  stream: true as const,
  context: { tenantId: 'acme' },
};

function setup(source: Parameters<typeof createMockStreamingClient>[0]) {
  const spy = spyStore();
  const usage = usageMiddleware({
    prices,
    pricesAsOf: daysAgo(1),
    attribute: ['tenantId'],
    budgets: [{ key: 'tenantId', limitTokens: 100_000, per: 'day' }],
    store: spy.store,
    logger: 'silent',
  });
  const llm = new VernLLM({
    client: createMockStreamingClient(source).client,
    model: 'gpt-6-sol',
    maxRetries: 0,
    logger: 'silent',
    defaultMaxTokens: 50,
    middleware: [usage],
  });
  const scope = () => spy.reserved()[0]!.scopes[0]!;
  return { llm, usage, spy, scope };
}

describe('streams', () => {
  it('holds the reservation while the stream runs and settles it when finalResult does', async () => {
    const { llm, spy, scope } = setup(chunks);

    const stream = await llm.call(call);
    expect(spy.log()).toEqual(['reserve']);
    expect(spy.open()).toBe(1);

    for await (const chunk of stream.chunks) void chunk;
    await expect(stream.finalResult).resolves.toBe('hello');
    await Promise.resolve();

    expect(spy.log()).toEqual(['reserve', 'commit']);
    expect(spy.open()).toBe(0);
    expect((await spy.store.read(scope())).spent).toEqual({ nanoUsd: 520_000, tokens: 100 });
  });

  it('frees the hold of a stream that reported no usage', async () => {
    const { llm, spy } = setup([{ type: 'text-delta', delta: 'hi' }]);

    const stream = await llm.call(call);
    for await (const chunk of stream.chunks) void chunk;
    await stream.finalResult;

    expect(spy.log()).toEqual(['reserve', 'release']);
    expect(spy.open()).toBe(0);
  });

  it('counts a stream in the totals once it finishes', async () => {
    const { llm, usage } = setup(chunks);

    const stream = await llm.call(call);
    expect(usage.totals({ tenantId: 'acme' }).calls).toBe(0);

    for await (const chunk of stream.chunks) void chunk;
    await stream.finalResult;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(usage.totals({ tenantId: 'acme' })).toMatchObject({
      calls: 1,
      estimatedCostUsd: 0.00052,
      tokens: { input: 60, output: 40 },
    });
  });

  it('settles a stream that breaks midway and still reaches the caller as an error', async () => {
    const { llm, spy } = setup(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', delta: 'hel' } as WireStreamChunk;
        throw new Error('connection lost');
      },
    }));

    const stream = await llm.call(call);
    await expect(
      (async () => {
        for await (const chunk of stream.chunks) void chunk;
        return stream.finalResult;
      })(),
    ).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(spy.open()).toBe(0);
  });

  it('counts an aborted stream as unknown spend, and keeps its hold as the spend', async () => {
    const { llm, usage, spy, scope } = setup((signal) => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', delta: 'hel' } as WireStreamChunk;
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('aborted'))),
        );
      },
    }));
    const controller = new AbortController();

    const stream = await llm.call({ ...call, signal: controller.signal });
    const finished = stream.finalResult.catch((e: unknown) => e);
    setTimeout(() => controller.abort(), 5);
    await expect(
      (async () => {
        for await (const chunk of stream.chunks) void chunk;
      })(),
    ).rejects.toThrow();
    await finished;
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The provider bills what was generated but never reports it, so the hold is committed as the
    // spend rather than released: aborting a stream must not be a way around a budget.
    expect(spy.open()).toBe(0);
    expect(spy.log()).toEqual(['reserve', 'commit']);
    expect((await spy.store.read(scope())).spent.tokens).toBeGreaterThanOrEqual(50);
    expect(usage.totals({ tenantId: 'acme' })).toMatchObject({ calls: 1, unknownSpendCalls: 1 });
  });
});

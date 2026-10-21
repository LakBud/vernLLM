import { VernLLM, type LLMClient } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { usageMiddleware } from '../../src/index.js';
import { createMockClient, daysAgo, spyStore, textResponse } from '../helpers.js';

const prices = { 'gpt-6-sol': { input: 2, output: 10 } };
const spent = { prompt_tokens: 60, completion_tokens: 40, total_tokens: 100 };
const call = { userContent: 'hi', jsonMode: false as const, context: { tenantId: 'acme' } };

function setup(client: LLMClient) {
  const spy = spyStore();
  const llm = new VernLLM({
    client,
    model: 'gpt-6-sol',
    maxRetries: 0,
    baseDelayMs: 1,
    logger: 'silent',
    defaultMaxTokens: 50,
    middleware: [
      usageMiddleware({
        prices,
        pricesAsOf: daysAgo(1),
        attribute: ['tenantId'],
        budgets: [{ key: 'tenantId', limitTokens: 100_000, per: 'day' }],
        store: spy.store,
        logger: 'silent',
      }),
    ],
  });
  const scope = () => spy.reserved()[0]!.scopes[0]!;
  return { llm, spy, scope };
}

describe('onEvent', () => {
  const event = { kind: 'usage', usage: {} } as never;

  it('ignores an event that arrives outside a call', () => {
    const usage = usageMiddleware({ prices, pricesAsOf: daysAgo(1), logger: 'silent' });

    expect(() => usage.onEvent!(event, undefined as never)).not.toThrow();
  });

  it('ignores an event of a call this middleware never saw', () => {
    const usage = usageMiddleware({ prices, pricesAsOf: daysAgo(1), logger: 'silent' });
    const ctx = { state: { get: () => undefined } } as never;

    expect(() => usage.onEvent!(event, ctx)).not.toThrow();
  });
});

describe('reservation lifecycle', () => {
  it('replaces the estimate with the real spend when a call succeeds', async () => {
    const { llm, spy, scope } = setup(createMockClient([textResponse('ok', spent)]).client);

    await llm.call(call);

    expect(spy.log()).toEqual(['reserve', 'commit']);
    expect(spy.open()).toBe(0);
    expect(await spy.store.read(scope())).toEqual({
      spent: { nanoUsd: 520_000, tokens: 100 },
      reserved: { nanoUsd: 0, tokens: 0 },
    });
  });

  it('frees the whole hold of a call that reported no usage, such as a provider error', async () => {
    const { llm, spy, scope } = setup(createMockClient([new Error('boom')]).client);

    await expect(llm.call(call)).rejects.toThrow();

    expect(spy.log()).toEqual(['reserve', 'release']);
    expect(spy.open()).toBe(0);
    expect(await spy.store.read(scope())).toEqual({
      spent: { nanoUsd: 0, tokens: 0 },
      reserved: { nanoUsd: 0, tokens: 0 },
    });
  });

  it('still counts the tokens of a response that was then rejected', async () => {
    const { llm, spy, scope } = setup(
      createMockClient([textResponse('{not valid json', spent)]).client,
    );

    await expect(llm.call({ ...call, jsonMode: true as never })).rejects.toThrow();

    expect(spy.open()).toBe(0);
    expect((await spy.store.read(scope())).spent).toEqual({ nanoUsd: 520_000, tokens: 100 });
  });

  it('frees the reservation when the call is aborted', async () => {
    const waiting = async (_params: unknown, signal: AbortSignal): Promise<never> =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const { llm, spy } = setup(createMockClient([waiting]).client);
    const controller = new AbortController();

    const pending = llm.call({ ...call, signal: controller.signal });
    setTimeout(() => controller.abort(), 5);

    await expect(pending).rejects.toThrow();
    expect(spy.open()).toBe(0);
  });
});

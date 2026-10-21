import { defaultEstimateTokens, VernLLM } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { usageMiddleware } from '../../src/index.js';
import { costProbe, createMockClient, daysAgo, textResponse } from '../helpers.js';

const call = { userContent: 'hi', jsonMode: false as const };
// 10,000 x 2,000 + 500 x 10,000 nano dollars.
const usage = { prompt_tokens: 10_000, completion_tokens: 500, total_tokens: 10_500 };

function setupWithMeter(
  client: ConstructorParameters<typeof VernLLM>[0]['client'],
  model = 'gpt-6-sol',
) {
  const probe = costProbe();
  const meter = usageMiddleware({
    prices: { 'gpt-6-sol': { input: 2, output: 10 } },
    pricesAsOf: daysAgo(1),
    logger: 'silent',
  });
  const llm = new VernLLM({
    client,
    model,
    maxRetries: 0,
    logger: 'silent',
    defaultMaxTokens: 50,
    middleware: [probe.middleware, meter],
  });
  return { llm, fields: probe.fields, usage: meter };
}

function setup(client: ConstructorParameters<typeof VernLLM>[0]['client']) {
  const probe = costProbe();
  const llm = new VernLLM({
    client,
    model: 'gpt-6-sol',
    maxRetries: 0,
    logger: 'silent',
    middleware: [
      probe.middleware,
      usageMiddleware({
        prices: { 'gpt-6-sol': { input: 2, output: 10 } },
        pricesAsOf: daysAgo(1),
        logger: 'silent',
      }),
    ],
  });
  return { llm, fields: probe.fields };
}

describe('cachedCall', () => {
  it('charges the call that ran and nothing for a hit', async () => {
    const mock = createMockClient([textResponse('a', usage)]);
    const { llm, fields } = setup(mock.client);
    const params = { cacheKey: 'k', ttl: 1000, call };

    await llm.cachedCall(params);
    await llm.cachedCall(params);

    expect(mock.calls).toHaveLength(1);
    expect(fields[0]).toEqual({ estimatedCostUsd: 0.025, wastedUsd: 0, costSource: 'table' });
    expect(fields[1]).toEqual({
      estimatedCostUsd: 0,
      wastedUsd: 0,
      estimatedSavedUsd: expect.any(Number),
    });
  });

  it('estimates what a hit spared: the request input and the stored answer, at the primary price', async () => {
    const mock = createMockClient([textResponse('a stored answer', usage)]);
    const { llm, fields, usage: meter } = setupWithMeter(mock.client);
    const params = { cacheKey: 'k', ttl: 1000, call };

    await llm.cachedCall(params);
    await llm.cachedCall(params);

    const sent = mock.calls[0] as never as { max_tokens: number };
    const input = defaultEstimateTokens(mock.calls[0] as never) - sent.max_tokens;
    // 'a stored answer' is 15 characters, so 4 tokens, at 10,000 nano dollars each.
    const saved = (input * 2_000 + 4 * 10_000) / 1e9;

    expect(fields[1]!.estimatedSavedUsd).toBeCloseTo(saved, 12);
    expect(fields[0]).not.toHaveProperty('estimatedSavedUsd');
    expect(meter.totals()).toMatchObject({ cacheHits: 1, calls: 2 });
    expect(meter.totals().estimatedSavedUsd).toBeCloseTo(saved, 12);
  });

  it('gives no estimate when the primary has no price', async () => {
    const mock = createMockClient([textResponse('a', usage)]);
    const { llm, fields } = setupWithMeter(mock.client, 'mystery');
    const params = { cacheKey: 'k', ttl: 1000, call };

    await llm.cachedCall(params);
    await llm.cachedCall(params);

    expect(fields[1]).toEqual({ estimatedCostUsd: 0, wastedUsd: 0 });
  });

  it('charges the shared call once, to the caller that ran it, and nothing to the one that joined', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const mock = createMockClient([async () => (await gate, textResponse('shared', usage))]);
    const { llm, fields } = setup(mock.client);
    const params = { cacheKey: 'j', ttl: 1000, call };

    const first = llm.cachedCall(params);
    const second = llm.cachedCall(params);
    release();
    await Promise.all([first, second]);

    const costs = fields.map((entry) => entry.estimatedCostUsd).sort();
    expect(mock.calls).toHaveLength(1);
    expect(costs).toEqual([0, 0.025]);
  });
});

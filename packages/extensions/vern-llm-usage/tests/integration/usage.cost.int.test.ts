import { VernLLM } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { usageMiddleware, type ModelPrices } from '../../src/index.js';
import { captureLogger, costProbe, createMockClient, daysAgo, textResponse } from '../helpers.js';

const call = { userContent: 'hi', jsonMode: false as const };

// $ per 1M tokens, which is 1000 nano dollars a token for every $1.
const prices: ModelPrices = {
  'gpt-6-sol': {
    input: 2,
    output: 10,
    cacheRead: 0.5,
    cacheWrite: { '5m': 2.5, '1h': 4 },
    reasoning: 20,
  },
  plain: { input: 2, output: 10 },
};

function setup(
  usage: Parameters<typeof textResponse>[1],
  model = 'gpt-6-sol',
  options: Partial<Parameters<typeof usageMiddleware>[0]> = {},
) {
  const probe = costProbe();
  const { client } = createMockClient([textResponse('a', usage)]);
  const llm = new VernLLM({
    client,
    model,
    maxRetries: 0,
    logger: 'silent',
    middleware: [
      probe.middleware,
      usageMiddleware({ prices, pricesAsOf: daysAgo(1), logger: 'silent', ...options }),
    ],
  });
  return { llm, fields: probe.fields };
}

describe('cost of one call', () => {
  it('prices uncached input and output', async () => {
    const { llm, fields } = setup({
      prompt_tokens: 10_000,
      completion_tokens: 500,
      total_tokens: 10_500,
    });

    await llm.call(call);

    // 10,000 x 2,000 + 500 x 10,000 nano dollars
    expect(fields).toEqual([{ estimatedCostUsd: 0.025, wastedUsd: 0, costSource: 'table' }]);
  });

  it('prices cache reads at their own rate, out of the prompt', async () => {
    const { llm, fields } = setup({
      prompt_tokens: 10_000,
      completion_tokens: 500,
      total_tokens: 10_500,
      prompt_tokens_details: { cached_tokens: 8_000 },
    });

    await llm.call(call);

    // 2,000 uncached x 2,000 + 8,000 read x 500 + 500 x 10,000
    expect(fields[0]!.estimatedCostUsd).toBe(0.013);
  });

  it('prices a cache read at the input rate when the table gives no read rate', async () => {
    const { llm, fields } = setup(
      {
        prompt_tokens: 10_000,
        completion_tokens: 500,
        total_tokens: 10_500,
        prompt_tokens_details: { cached_tokens: 8_000 },
      },
      'plain',
    );

    await llm.call(call);

    expect(fields[0]!.estimatedCostUsd).toBe(0.025);
  });

  it('prices cache writes by TTL, with the rest of the prompt uncached', async () => {
    const { llm, fields } = setup({
      prompt_tokens: 10_000,
      completion_tokens: 500,
      total_tokens: 10_500,
      prompt_tokens_details: {
        cache_write_tokens: 1_500,
        cache_write_tokens_by_ttl: { '5m': 1_000, '1h': 500 },
      },
    });

    await llm.call(call);

    // 8,500 x 2,000 + 1,000 x 2,500 + 500 x 4,000 + 500 x 10,000
    expect(fields[0]!.estimatedCostUsd).toBe(0.0265);
  });

  it('prices reasoning at its own rate, inside the completion and never on top', async () => {
    const { llm, fields } = setup({
      prompt_tokens: 1_000,
      completion_tokens: 500,
      total_tokens: 1_500,
      completion_tokens_details: { reasoning_tokens: 300 },
    });

    await llm.call(call);

    // 1,000 x 2,000 + 300 x 20,000 + 200 x 10,000
    expect(fields[0]!.estimatedCostUsd).toBe(0.01);
  });

  it('reports nothing wasted for a call that succeeded', async () => {
    const { llm, fields } = setup({
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
    });

    await llm.call(call);

    expect(fields[0]!.wastedUsd).toBe(0);
  });
});

describe('a model with no price', () => {
  it('is counted as unpriced and costs nothing, never a guess', async () => {
    const { llm, fields } = setup(
      { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
      'mystery',
    );

    await llm.call(call);

    expect(fields).toEqual([{ estimatedCostUsd: 0, wastedUsd: 0, costSource: 'unpriced' }]);
  });

  it('warns once per model, not once per call', async () => {
    const { logger, warnings } = captureLogger();
    const { llm } = setup(
      { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
      'mystery',
      { logger },
    );

    await llm.call(call);
    await llm.call(call);

    expect(
      warnings().filter((message) => message.includes('no price for model "mystery"')),
    ).toHaveLength(1);
  });

  it('is priced by a more specific target key before the model key', async () => {
    const { llm, fields } = setup(
      { prompt_tokens: 1_000, completion_tokens: 0, total_tokens: 1_000 },
      'plain',
      { prices: { plain: { input: 2, output: 10 }, 'primary/plain': { input: 4, output: 10 } } },
    );

    await llm.call(call);

    expect(fields[0]!.estimatedCostUsd).toBe(0.004);
  });
});

describe('the price table', () => {
  it('warns once when pricesAsOf is older than maxPriceAgeDays', () => {
    const { logger, warnings } = captureLogger();

    usageMiddleware({ prices, pricesAsOf: daysAgo(120), logger });

    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toMatch(/prices are 120 days old/);
  });

  it('stays quiet while the prices are recent enough', () => {
    const { logger, warnings } = captureLogger();

    usageMiddleware({ prices, pricesAsOf: daysAgo(30), logger });

    expect(warnings()).toEqual([]);
  });

  it('honors a custom maxPriceAgeDays', () => {
    const { logger, warnings } = captureLogger();

    usageMiddleware({ prices, pricesAsOf: daysAgo(30), maxPriceAgeDays: 7, logger });

    expect(warnings()).toHaveLength(1);
  });

  it('applies normalizeModel before the lookup', async () => {
    const { llm, fields } = setup(
      { prompt_tokens: 1_000, completion_tokens: 0, total_tokens: 1_000 },
      'plain-2026-10-01',
      { normalizeModel: (model) => model.replace(/-\d{4}-\d{2}-\d{2}$/, '') },
    );

    await llm.call(call);

    expect(fields[0]).toMatchObject({ estimatedCostUsd: 0.002, costSource: 'table' });
  });

  it('prices through priceFor, and counts a throwing one as unpriced', async () => {
    const good = setup(
      { prompt_tokens: 1_000, completion_tokens: 0, total_tokens: 1_000 },
      'plain',
      { prices: undefined, pricesAsOf: undefined, priceFor: () => ({ input: 3, output: 3 }) },
    );
    const broken = setup(
      { prompt_tokens: 1_000, completion_tokens: 0, total_tokens: 1_000 },
      'plain',
      {
        prices: undefined,
        pricesAsOf: undefined,
        priceFor: () => {
          throw new Error('price service down');
        },
      },
    );

    await good.llm.call(call);
    await expect(broken.llm.call(call)).resolves.toBe('a');

    expect(good.fields[0]!.estimatedCostUsd).toBe(0.003);
    expect(broken.fields[0]).toMatchObject({ estimatedCostUsd: 0, costSource: 'unpriced' });
  });
});

describe('a call that reports no usage', () => {
  it('stores a zero cost without claiming a source', async () => {
    const { llm, fields } = setup(undefined);

    await llm.call(call);

    expect(fields).toEqual([{ estimatedCostUsd: 0, wastedUsd: 0 }]);
  });
});

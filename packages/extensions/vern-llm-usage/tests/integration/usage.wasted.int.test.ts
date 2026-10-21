import { VernLLM } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { usageMiddleware } from '../../src/index.js';
import { costProbe, createMockClient, daysAgo, textResponse } from '../helpers.js';

const prices = {
  'gpt-6-sol': { input: 2, output: 10 },
  cheap: { input: 1, output: 1 },
};

// 1,000 x 2,000 + 100 x 10,000 nano dollars at the gpt-6-sol rates.
const rejected = { prompt_tokens: 1_000, completion_tokens: 100, total_tokens: 1_100 };
// 2,000 x 2,000 + 200 x 10,000 nano dollars at the gpt-6-sol rates.
const accepted = { prompt_tokens: 2_000, completion_tokens: 200, total_tokens: 2_200 };

/** Flags the placeholder answer as a soft failure, so its tokens were spent for nothing. */
const detectSoftFailure = (result: unknown) =>
  result === 'bad' ? ('soft_failure_detected' as const) : undefined;

function setup(
  client: ConstructorParameters<typeof VernLLM>[0]['client'],
  extra: Partial<ConstructorParameters<typeof VernLLM>[0]> = {},
) {
  const probe = costProbe();
  const llm = new VernLLM({
    client,
    model: 'gpt-6-sol',
    maxRetries: 0,
    baseDelayMs: 1,
    logger: 'silent',
    detectSoftFailure,
    middleware: [
      probe.middleware,
      usageMiddleware({ prices, pricesAsOf: daysAgo(1), logger: 'silent' }),
    ],
    ...extra,
  });
  return { llm, fields: probe.fields };
}

const call = { userContent: 'hi', jsonMode: false as const };

describe('wasted spend', () => {
  it('counts a soft failure that was retried as wasted, on top of the answer that was kept', async () => {
    const { client } = createMockClient([
      textResponse('bad', rejected),
      textResponse('good', accepted),
    ]);
    const { llm, fields } = setup(client, { maxRetries: 1 });

    await expect(llm.call(call)).resolves.toBe('good');

    expect(fields).toEqual([{ estimatedCostUsd: 0.009, wastedUsd: 0.003, costSource: 'table' }]);
  });

  it('counts the tokens behind a rejected call, whose error still reaches the caller', async () => {
    const { client } = createMockClient([textResponse('{not valid json', rejected)]);
    const { llm, fields } = setup(client);

    await expect(llm.call({ userContent: 'hi' })).rejects.toMatchObject({ type: 'parse' });

    expect(fields).toEqual([{ estimatedCostUsd: 0.003, wastedUsd: 0.003, costSource: 'table' }]);
  });

  it('prices a fallback target by its own model after the primary was rejected', async () => {
    const primary = createMockClient([textResponse('bad', rejected)]);
    const backup = createMockClient([textResponse('good', accepted)]);
    const { llm, fields } = setup(primary.client, {
      fallback: { client: backup.client, model: 'cheap', name: 'backup' },
    });

    await expect(llm.call(call)).resolves.toBe('good');

    // 3,000,000 wasted on gpt-6-sol, then 2,000 x 1,000 + 200 x 1,000 on cheap.
    expect(fields).toEqual([{ estimatedCostUsd: 0.0052, wastedUsd: 0.003, costSource: 'table' }]);
  });

  it('keeps a call that failed before any usage at zero, and rethrows its own error', async () => {
    const { client } = createMockClient([Object.assign(new Error('boom'), { status: 500 })]);
    const { llm, fields } = setup(client);

    await expect(llm.call(call)).rejects.toMatchObject({ type: 'api', status: 500 });

    expect(fields).toEqual([{ estimatedCostUsd: 0, wastedUsd: 0 }]);
  });
});

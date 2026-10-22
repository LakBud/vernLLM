import { VernLLM, type LLMClient } from 'vern-llm';
import { loggerMiddleware, memorySink, type CallLogRecord } from 'vern-llm-logger';
import { describe, expect, it } from 'vitest';

import { usageLogFields, usageMiddleware } from '../../src/index.js';
import { createMockClient, createMockStreamingClient, daysAgo, textResponse } from '../helpers.js';

const prices = { 'gpt-6-sol': { input: 2, output: 10 } };
const spent = { prompt_tokens: 60, completion_tokens: 40, total_tokens: 100 };
const call = { userContent: 'hi', jsonMode: false as const, context: { tenantId: 'acme' } };

function setup(client: LLMClient, warnAt?: number) {
  const sink = memorySink();
  const llm = new VernLLM({
    client,
    model: 'gpt-6-sol',
    maxRetries: 0,
    logger: 'silent',
    defaultMaxTokens: 50,
    // The logger outermost, so the usage middleware's `next()` has returned when it builds a record.
    middleware: [
      loggerMiddleware({ sink, enrich: usageLogFields, logger: 'silent' }),
      usageMiddleware({
        prices,
        pricesAsOf: daysAgo(1),
        attribute: ['tenantId'],
        budgets: [{ key: 'tenantId', limitTokens: 200, per: 'day' }],
        warnAt,
        logger: 'silent',
      }),
    ],
  });
  return { llm, records: () => sink.entries.map(({ entry }) => entry as CallLogRecord) };
}

describe('with the logger', () => {
  it('puts the cost in the record fields', async () => {
    const { llm, records } = setup(createMockClient([textResponse('ok', spent)]).client);

    await llm.call(call);

    expect(records()[0]).toMatchObject({
      outcome: 'ok',
      fields: { estimatedCostUsd: 0.00052, wastedUsd: 0, costSource: 'table' },
    });
  });

  it('puts the cost of a stream in the record, which is written when finalResult settles', async () => {
    const { llm, records } = setup(
      createMockStreamingClient([
        { type: 'text-delta', delta: 'hi' },
        { type: 'usage', usage: spent },
      ]).client,
    );

    const stream = await llm.call({ ...call, stream: true as const });
    for await (const chunk of stream.chunks) void chunk;
    await stream.finalResult;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({
      streaming: true,
      fields: { estimatedCostUsd: 0.00052, costSource: 'table' },
    });
  });

  it('carries the budget warning in the record as a custom event', async () => {
    const { llm, records } = setup(createMockClient([textResponse('ok', spent)]).client, 0.5);

    await llm.call(call);

    expect(records()[0]!.custom).toEqual({
      'usage.budget_warning': [
        {
          v: 1,
          scope: 'tenantId=acme per day',
          unit: 'tokens',
          limit: 200,
          threshold: 0.5,
          mode: 'hard',
          used: 0.5,
        },
      ],
    });
  });

  it('carries the budget warning of a stream in its record too', async () => {
    const { llm, records } = setup(
      createMockStreamingClient([
        { type: 'text-delta', delta: 'hi' },
        { type: 'usage', usage: spent },
      ]).client,
      0.5,
    );

    const stream = await llm.call({ ...call, stream: true as const });
    for await (const chunk of stream.chunks) void chunk;
    await stream.finalResult;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(records()[0]!.custom).toMatchObject({ 'usage.budget_warning': [{ used: 0.5 }] });
  });

  it('logs a call over budget as rejected, with no attempts and the budget that was hit', async () => {
    const mock = createMockClient([textResponse('ok', spent)]);
    const { llm, records } = setup(mock.client);

    await llm.call(call);
    await llm.call(call);
    await expect(llm.call(call)).rejects.toMatchObject({ code: 'budget_exceeded' });

    const rejected = records()[2]!;
    expect(rejected).toMatchObject({
      outcome: 'rejected',
      level: 'warn',
      attempts: 0,
      error: { type: 'quota_exceeded', code: 'budget_exceeded' },
      custom: {
        'usage.budget_exceeded': [{ v: 1, scope: 'tenantId=acme per day', unit: 'tokens' }],
      },
    });
    expect(mock.calls).toHaveLength(2);
  });
});

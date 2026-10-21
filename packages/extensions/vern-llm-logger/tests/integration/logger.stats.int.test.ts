import { VernLLM } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { loggerMiddleware, memorySink } from '../../src/index.js';
import { createMockClient, sleep, textResponse } from '../helpers.js';

const call = { userContent: 'hi', jsonMode: false as const };
const usage = { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 };

function setup(script: Parameters<typeof createMockClient>[0], options = {}) {
  const logger = loggerMiddleware({
    sink: memorySink(),
    logger: 'silent',
    minSamples: 3,
    ...options,
  });
  const llm = new VernLLM({
    client: createMockClient(script).client,
    model: 'gpt-4o',
    maxRetries: 0,
    logger: 'silent',
    middleware: [logger],
  });
  return { llm, logger };
}

describe('logger.stats', () => {
  it('times successful calls and answers quantile queries', async () => {
    const { llm, logger } = setup([async () => (await sleep(15), textResponse('ok', usage))]);

    for (let i = 0; i < 4; i++) await llm.call(call);

    const all = logger.stats.snapshot().series.find((s) => s.metric === 'durationMs')!;
    expect(all.count).toBe(4);
    expect(Object.keys(all.quantiles)).toEqual(['0.5', '0.9', '0.95', '0.99']);
    expect(logger.stats.quantile({ provider: 'primary' }, 0.5)).toBeGreaterThanOrEqual(10);
    expect(logger.stats.quantile({ provider: 'primary' }, 0.5, 'attemptMs')).toBeGreaterThan(0);
    expect(logger.stats.quantile({ provider: 'nobody' }, 0.5)).toBeUndefined();
  });

  it('counts failures instead of timing them', async () => {
    const { llm, logger } = setup([new Error('down')]);

    for (let i = 0; i < 3; i++) await llm.call(call).catch(() => {});

    const all = logger.stats.snapshot().series[0]!;
    expect(all).toMatchObject({ count: 0, errors: 3 });
  });

  it('keeps cache hits out of the latency series and counts them', async () => {
    const { llm, logger } = setup([textResponse('a')]);
    const params = { cacheKey: 'k', ttl: 1000, call };

    for (let i = 0; i < 4; i++) await llm.cachedCall(params);

    const all = logger.stats.snapshot().series.find((s) => s.metric === 'durationMs')!;
    expect(all).toMatchObject({ count: 1, cacheHits: 3 });
  });

  it('sees calls the sink level filter drops', async () => {
    const sink = memorySink();
    const { llm, logger } = setup([textResponse('ok')], { sink, level: 'error' });

    for (let i = 0; i < 3; i++) await llm.call(call);

    expect(sink.entries).toHaveLength(0);
    expect(logger.stats.snapshot().series[0]!.count).toBe(3);
  });

  it('resets', async () => {
    const { llm, logger } = setup([textResponse('ok')]);
    await llm.call(call);

    logger.stats.reset();

    expect(logger.stats.snapshot().series).toEqual([]);
  });

  it('is private to each instance', async () => {
    const first = setup([textResponse('ok')]);
    const second = setup([textResponse('ok')]);
    await first.llm.call(call);

    expect(second.logger.stats.snapshot().series).toEqual([]);
  });
});

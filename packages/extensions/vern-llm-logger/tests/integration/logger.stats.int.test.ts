import { VernLLM } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { loggerMiddleware, memorySink } from '../../src/index.js';
import {
  createMockClient,
  createMockStreamingClient,
  FakeApiError,
  sleep,
  textResponse,
} from '../helpers.js';

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

describe('outputTokens', () => {
  it('is a rolling series of completion tokens per successful call', async () => {
    const { llm, logger } = setup([textResponse('ok', usage)]);

    for (let i = 0; i < 4; i++) await llm.call(call);

    expect(logger.stats.quantile({ provider: 'primary' }, 0.5, 'outputTokens')).toBeCloseTo(4, 0);
    expect(logger.stats.snapshot().series.find((s) => s.metric === 'outputTokens')).toMatchObject({
      count: 4,
    });
  });

  it('leaves out failed calls and calls without usage', async () => {
    const { llm, logger } = setup([textResponse('ok'), new Error('down')]);

    await llm.call(call);
    await llm.call(call).catch(() => {});

    expect(logger.stats.snapshot().series.find((s) => s.metric === 'outputTokens')).toBeUndefined();
  });
});

describe('failureRate quality', () => {
  const jsonCall = { userContent: 'hi', jsonMode: true as const };
  const good = textResponse('{"a":1}', usage);
  const bad = textResponse('not json', usage);

  const run = async (llm: VernLLM, times: number, params: object = jsonCall) => {
    for (let i = 0; i < times; i++) await llm.call(params as typeof jsonCall).catch(() => {});
  };

  it('is the share of responded attempts whose answer was unusable', async () => {
    const { llm, logger } = setup([good, bad, good, good, bad, good, good, bad, good, good]);

    await run(llm, 10);

    expect(logger.stats.failureRate({ provider: 'primary' }, 'quality')).toBeCloseTo(0.3);
    expect(logger.stats.failureRate({}, 'quality')).toBeCloseTo(0.3);
  });

  it('is undefined below minSamples responded attempts', async () => {
    const { llm, logger } = setup([bad]);

    await run(llm, 2);

    expect(logger.stats.failureRate({ provider: 'primary' }, 'quality')).toBeUndefined();
  });

  it('does not count outages, so an outage is neither good nor bad quality', async () => {
    const { llm, logger } = setup([good, good, good, good, new FakeApiError('down', 500)]);

    await run(llm, 8);

    expect(logger.stats.failureRate({ provider: 'primary' }, 'quality')).toBe(0);

    const down = setup([new FakeApiError('down', 500)]);
    await run(down.llm, 6);

    expect(down.logger.stats.failureRate({ provider: 'primary' }, 'quality')).toBeUndefined();
  });

  it('counts a call a fallback rescued against the target that failed', async () => {
    const logger = loggerMiddleware({ sink: memorySink(), logger: 'silent', minSamples: 3 });
    const llm = new VernLLM({
      client: createMockClient([bad]).client,
      model: 'gpt-4o',
      maxRetries: 0,
      logger: 'silent',
      fallback: { client: createMockClient([good]).client, model: 'gpt-4o', name: 'rescue' },
      // A parse failure stops the chain by default, so a rescue is something the app opts into.
      fallbackOn: () => 'next',
      middleware: [logger],
    });

    await run(llm, 5);

    expect(logger.stats.failureRate({ provider: 'primary' }, 'quality')).toBe(1);
    expect(logger.stats.failureRate({ provider: 'rescue' }, 'quality')).toBe(0);
    expect(logger.stats.failureRate({}, 'quality')).toBeCloseTo(0.5);
    // The calls all succeeded, so latency stays under the target that answered.
    expect(logger.stats.quantile({ provider: 'rescue' }, 0.5)).toBeDefined();
    expect(logger.stats.quantile({ provider: 'primary' }, 0.5)).toBeUndefined();
  });

  it('counts each attempt of a call, retries included', async () => {
    const logger = loggerMiddleware({ sink: memorySink(), logger: 'silent', minSamples: 3 });
    const llm = new VernLLM({
      client: createMockClient([
        textResponse('refused', usage),
        textResponse('answer', usage),
        textResponse('refused', usage),
        textResponse('answer', usage),
        textResponse('refused', usage),
        textResponse('answer', usage),
      ]).client,
      model: 'gpt-4o',
      maxRetries: 1,
      baseDelayMs: 1,
      logger: 'silent',
      detectSoftFailure: (result) => (result === 'refused' ? 'soft_failure_detected' : undefined),
      middleware: [logger],
    });

    await run(llm, 3, call);

    // Every call made two responded attempts, and the first was rejected.
    expect(logger.stats.failureRate({ provider: 'primary' }, 'quality')).toBeCloseTo(0.5);
  });

  it('counts a stream that finished as a responded attempt, under the streaming dimension', async () => {
    const logger = loggerMiddleware({ sink: memorySink(), logger: 'silent', minSamples: 3 });
    const llm = new VernLLM({
      client: createMockStreamingClient([
        [
          { type: 'text-delta', delta: 'hello' },
          { type: 'usage', usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } },
        ],
      ]).client,
      model: 'gpt-4o',
      maxRetries: 0,
      logger: 'silent',
      middleware: [logger],
    });

    for (let i = 0; i < 4; i++) {
      const { finalResult } = await llm.call({ ...call, stream: true });
      await finalResult;
    }

    expect(logger.stats.failureRate({ provider: 'primary', streaming: 'true' }, 'quality')).toBe(0);
    expect(logger.stats.failureRate({ streaming: 'false' }, 'quality')).toBeUndefined();
  });

  it('resets with the other stats', async () => {
    const { llm, logger } = setup([bad]);
    await run(llm, 4);
    expect(logger.stats.failureRate({}, 'quality')).toBe(1);

    logger.stats.reset();

    expect(logger.stats.failureRate({}, 'quality')).toBeUndefined();
  });
});

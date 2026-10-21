import { VernLLM, type VernLLMMiddleware } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { fromEvent, loggerMiddleware, memorySink } from '../../src/index.js';
import { createMockClient, textResponse } from '../helpers.js';

const call = { userContent: 'hi', jsonMode: false as const };

const emitter = (data: unknown): VernLLMMiddleware => ({
  name: 'emitter',
  wrap: async (_request, next, ctx) => {
    ctx.emit('router.decision', data as never);
    return next();
  },
});

function setup(emits: unknown[]) {
  let index = 0;
  const logger = loggerMiddleware({
    sink: memorySink(),
    logger: 'silent',
    minSamples: 2,
    dimensions: { route: fromEvent('router.decision', 'route') },
  });
  const llm = new VernLLM({
    client: createMockClient([textResponse('ok')]).client,
    model: 'gpt-4o',
    maxRetries: 0,
    logger: 'silent',
    middleware: [
      {
        name: 'pick',
        wrap: (request, next, ctx) =>
          emitter(emits[index++ % emits.length]).wrap!(request, next, ctx),
      },
      logger,
    ],
  });
  return { llm, logger };
}

describe('fromEvent dimensions', () => {
  it('keys percentiles by a field of a custom event', async () => {
    const { llm, logger } = setup([{ route: 'cheap' }, { route: 'cheap' }, { route: 'fast' }]);

    for (let i = 0; i < 6; i++) await llm.call(call);

    expect(
      logger.stats.snapshot().series.find((s) => s.dimensions.route === 'cheap'),
    ).toMatchObject({ metric: 'durationMs', count: 4 });
    expect(logger.stats.quantile({ route: 'fast' }, 0.5)).toBeDefined();
    expect(logger.stats.quantile({ route: 'other' }, 0.5)).toBeUndefined();
  });

  it('leaves the dimension out for a missing, non string or malformed field', async () => {
    const { llm, logger } = setup([{ route: 5 }, {}, 'text', null, [1]]);

    for (let i = 0; i < 5; i++) await llm.call(call);

    const withRoute = logger.stats.snapshot().series.filter((s) => 'route' in s.dimensions);
    expect(withRoute).toEqual([]);
    expect(logger.stats.snapshot().series.find((s) => s.metric === 'durationMs')!.count).toBe(5);
  });
});

describe('dimension extractors', () => {
  it('run once per call', async () => {
    let runs = 0;
    const logger = loggerMiddleware({
      sink: memorySink(),
      logger: 'silent',
      dimensions: {
        counted: () => {
          runs++;
          return 'x';
        },
      },
    });
    const llm = new VernLLM({
      client: createMockClient([textResponse('ok')]).client,
      model: 'gpt-4o',
      logger: 'silent',
      middleware: [logger],
    });

    await llm.call(call);
    await llm.call(call);

    expect(runs).toBe(2);
  });
});

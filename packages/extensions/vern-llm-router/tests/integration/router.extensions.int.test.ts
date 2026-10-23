import { VernLLM } from 'vern-llm';
import { loggerMiddleware, memorySink } from 'vern-llm-logger';
import { usageMiddleware } from 'vern-llm-usage';
import { describe, expect, it } from 'vitest';

import { driftDimension, routeDimension, routerMiddleware } from '../../src/index.js';
import { rateLimitError, targetChain } from '../helpers.js';

const call = { userContent: 'hi', jsonMode: false as const };
const today = new Date().toISOString().slice(0, 10);

function setup(scripts: Parameters<typeof targetChain>[0] = {}) {
  const chain = targetChain(scripts);
  const sink = memorySink();
  const logger = loggerMiddleware({
    sink,
    minSamples: 1,
    logger: 'silent',
    dimensions: { route: routeDimension, drift: driftDimension },
  });
  const usage = usageMiddleware({
    prices: {
      'primary-model': { input: 10, output: 10 },
      'b-model': { input: 1, output: 1 },
      'c-model': { input: 5, output: 5 },
    },
    pricesAsOf: today,
    logger: 'silent',
  });
  const holder: { llm?: VernLLM } = {};
  const router = routerMiddleware({
    logger: 'silent',
    health: () => holder.llm as never,
    stats: logger.stats,
    cost: usage.costFor,
    random: () => 0.99,
    routes: [{ name: 'cheap', strategy: { type: 'rank', weights: { cost: 1 }, explore: 0 } }],
  });
  const llm = new VernLLM({ ...chain.options, middleware: [logger, usage, router] });
  holder.llm = llm;
  return { llm, chain, sink, logger };
}

describe('with the logger and usage', () => {
  it('prices targets through usage.costFor and sends the call to the cheapest', async () => {
    const { llm, chain } = setup();

    await llm.call(call);

    expect(chain.tried()).toEqual(['b']);
  });

  it('puts the route and drift on the logger series', async () => {
    const { llm, sink, logger } = setup({ b: [rateLimitError()] });

    await llm.call(call);

    const record = sink.entries.map((e) => e.entry).find((e) => e.kind === 'call');
    expect(record).toMatchObject({ provider: 'c' });
    const series = logger.stats.snapshot().series;
    expect(series.some((s) => s.dimensions.route === 'cheap' && s.dimensions.drift === 'yes')).toBe(
      true,
    );
    logger.dispose();
  });
});

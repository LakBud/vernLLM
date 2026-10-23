import { VernLLM } from 'vern-llm';
import { describe, expect, it } from 'vitest';

import { routerMiddleware, type RouterOptions } from '../../src/index.js';
import { captureLogger, targetChain } from '../helpers.js';

const call = { userContent: 'hi', jsonMode: false as const };

function setup(router: RouterOptions) {
  const log = captureLogger();
  const chain = targetChain();
  const llm = new VernLLM({
    ...chain.options,
    middleware: [routerMiddleware({ logger: log.logger, random: () => 0, ...router })],
  });
  return { llm, chain, log };
}

const rank = (weights: object, extra: object = {}) => ({
  type: 'rank' as const,
  weights,
  explore: 0,
  ...extra,
});

describe('failsafe', () => {
  it('runs the call untouched when a stats source throws, with one report', async () => {
    const { llm, chain, log } = setup({
      stats: {
        quantile: () => {
          throw new Error('stats down');
        },
      },
      routes: [{ name: 'r', strategy: rank({ latency: 1 }) }],
    });

    await expect(llm.call(call)).resolves.toBe('primary');

    expect(chain.tried()).toEqual(['primary']);
    expect(log.errors()).toHaveLength(1);
    expect(log.errors()[0]).toContain('stats failed');
  });

  it('runs the call untouched when the cost source throws, with one report', async () => {
    const { llm, chain, log } = setup({
      cost: () => {
        throw new Error('prices down');
      },
      routes: [{ name: 'r', strategy: rank({ cost: 1 }) }],
    });

    await llm.call(call);

    expect(chain.tried()).toEqual(['primary']);
    expect(log.errors()).toHaveLength(1);
    expect(log.errors()[0]).toContain('cost failed');
  });

  it('runs the call untouched when a custom metric throws, with one report', async () => {
    const { llm, chain, log } = setup({
      routes: [
        {
          name: 'r',
          strategy: rank(
            { custom: 1 },
            {
              custom: () => {
                throw new Error('bad metric');
              },
            },
          ),
        },
      ],
    });

    await llm.call(call);

    expect(chain.tried()).toEqual(['primary']);
    expect(log.errors()).toHaveLength(1);
    expect(log.errors()[0]).toContain('custom failed');
  });

  it('runs the call untouched when a route function throws, with one report', async () => {
    const { llm, chain, log } = setup({
      routes: [
        {
          name: 'r',
          when: () => {
            throw new Error('bad matcher');
          },
          targets: ['c'],
        },
      ],
    });

    await llm.call(call);

    expect(chain.tried()).toEqual(['primary']);
    expect(log.errors()).toHaveLength(1);
    expect(log.errors()[0]).toContain('decide failed');
  });

  it('keeps routing on what is known when only one source fails', async () => {
    const { llm, chain } = setup({
      stats: { quantile: () => 500 },
      cost: (target) => {
        if (target.name === 'b') throw new Error('one price down');
        return target.name === 'primary' ? 5 : 1;
      },
      routes: [{ name: 'r', strategy: rank({ cost: 1 }, { tolerance: 0 }) }],
    });

    await llm.call(call);

    // b is unknown and scores at the median of primary and c; c is cheapest.
    expect(chain.tried()).toEqual(['c']);
  });
});

import { describe, expect, it } from 'vitest';

import { toResolvedPrice } from '../../../../src/internal/options/normalizePrices.utils.js';
import {
  chargeNanoUsd,
  nanoToUsd,
  reportedNanoUsd,
  toPublicAmount,
  tokenKinds,
} from '../../../../src/internal/pricing/charge.utils.js';

import type { ModelPrice } from '../../../../src/index.js';

// Input 2, output 10: 2,000 and 10,000 nano dollars a token.
const price = (overrides: Partial<ModelPrice> = {}) =>
  toResolvedPrice({ input: 2, output: 10, ...overrides }, 'price');

describe('chargeNanoUsd', () => {
  it('prices input and output', () => {
    expect(chargeNanoUsd({ promptTokens: 10, completionTokens: 5 }, price())).toBe(
      10 * 2_000 + 5 * 10_000,
    );
  });

  it('takes cache reads out of the prompt, never on top of it', () => {
    const tokens = { promptTokens: 100, completionTokens: 0, cacheReadTokens: 60 };

    expect(chargeNanoUsd(tokens, price({ cacheRead: 0.5 }))).toBe(40 * 2_000 + 60 * 500);
  });

  it('defaults cache reads and writes to the input rate', () => {
    const tokens = {
      promptTokens: 100,
      completionTokens: 0,
      cacheReadTokens: 30,
      cacheWriteTokens: 20,
    };

    expect(chargeNanoUsd(tokens, price())).toBe(100 * 2_000);
  });

  it('prices writes with a TTL rate by it and the rest at the flat rate', () => {
    const tokens = {
      promptTokens: 100,
      completionTokens: 0,
      cacheWriteTokens: 50,
      cacheWriteTokensByTtl: { '5m': 20, '1h': 10 },
    };
    const rates = price({ cacheWrite: { '5m': 3, '1h': 4 } });

    // 20 at 3,000 and 10 at 4,000, the 20 left over at the input rate, 50 uncached.
    expect(chargeNanoUsd(tokens, rates)).toBe(50 * 2_000 + 20 * 3_000 + 10 * 4_000 + 20 * 2_000);
  });

  it('prices a TTL label the table has no rate for at the flat write rate', () => {
    const tokens = {
      promptTokens: 10,
      completionTokens: 0,
      cacheWriteTokensByTtl: { '24h': 10 },
    };

    expect(chargeNanoUsd(tokens, price({ cacheWrite: { '5m': 3 } }))).toBe(10 * 2_000);
  });

  it('uses the TTL split as the write count when the total is missing', () => {
    const tokens = {
      promptTokens: 100,
      completionTokens: 0,
      cacheWriteTokensByTtl: { '5m': 40 },
    };

    expect(chargeNanoUsd(tokens, price({ cacheWrite: { '5m': 3 } }))).toBe(60 * 2_000 + 40 * 3_000);
  });

  it('prices reasoning inside the completion, at its own rate', () => {
    const tokens = { promptTokens: 0, completionTokens: 50, reasoningTokens: 30 };

    expect(chargeNanoUsd(tokens, price({ reasoning: 20 }))).toBe(30 * 20_000 + 20 * 10_000);
  });

  it('prices reasoning at the output rate by default, so the split changes nothing', () => {
    const split = { promptTokens: 0, completionTokens: 50, reasoningTokens: 30 };
    const whole = { promptTokens: 0, completionTokens: 50 };

    expect(chargeNanoUsd(split, price())).toBe(chargeNanoUsd(whole, price()));
  });

  describe('clamping', () => {
    it('never lets uncached input go below zero', () => {
      const tokens = {
        promptTokens: 10,
        completionTokens: 0,
        cacheReadTokens: 50,
        cacheWriteTokens: 50,
      };

      expect(chargeNanoUsd(tokens, price())).toBe(100 * 2_000);
    });

    it('caps reasoning at the completion', () => {
      const tokens = { promptTokens: 0, completionTokens: 10, reasoningTokens: 99 };

      expect(chargeNanoUsd(tokens, price({ reasoning: 20 }))).toBe(10 * 20_000);
    });

    it('treats negative, fractional and non finite counts as none or whole', () => {
      const tokens = {
        promptTokens: -5,
        completionTokens: Number.NaN,
        cacheReadTokens: Number.POSITIVE_INFINITY,
        reasoningTokens: 2.9,
      };

      expect(chargeNanoUsd(tokens, price())).toBe(0);
      expect(chargeNanoUsd({ promptTokens: 2.9, completionTokens: 0 }, price())).toBe(2 * 2_000);
    });
  });
});

describe('rounding to nano dollars', () => {
  it('rounds a rate to the nearest nano dollar per token, so a float price stays exact', () => {
    // 1.1 * 1000 is 1100.0000000000002 as a float.
    expect(chargeNanoUsd({ promptTokens: 1, completionTokens: 0 }, price({ input: 1.1 }))).toBe(
      1_100,
    );
  });

  it('keeps a cheap model exact: $0.075 per 1M tokens is 75 nano dollars a token', () => {
    expect(
      chargeNanoUsd({ promptTokens: 1_000_000, completionTokens: 0 }, price({ input: 0.075 })),
    ).toBe(75_000_000);
  });
});

describe('nanoToUsd', () => {
  it('converts whole nano dollars to the plain USD number', () => {
    expect(nanoToUsd(3_100_000)).toBe(0.0031);
    expect(nanoToUsd(0)).toBe(0);
  });
});

describe('tokenKinds', () => {
  it('reports each kind as reported, and the larger of the write total and its TTL split', () => {
    expect(
      tokenKinds({
        promptTokens: 100,
        completionTokens: 20,
        reasoningTokens: 5,
        cacheReadTokens: 30,
        cacheWriteTokens: 10,
        cacheWriteTokensByTtl: { '5m': 8, '1h': 7 },
      }),
    ).toEqual({ input: 100, output: 20, cacheRead: 30, cacheWrite: 15, reasoning: 5 });
  });

  it('counts missing, negative and non finite values as zero', () => {
    expect(
      tokenKinds({ promptTokens: -1, completionTokens: Number.NaN, cacheReadTokens: 2.9 }),
    ).toEqual({ input: 0, output: 0, cacheRead: 2, cacheWrite: 0, reasoning: 0 });
  });
});

describe('toPublicAmount', () => {
  it('converts dollar scopes from nano dollars and leaves tokens alone', () => {
    expect(toPublicAmount('usd', 2_500_000_000)).toBe(2.5);
    expect(toPublicAmount('tokens', 1_200)).toBe(1_200);
  });
});

describe('reportedNanoUsd', () => {
  it('converts a reported cost to integer nano dollars, zero included', () => {
    expect(reportedNanoUsd(0.0042)).toBe(4_200_000);
    expect(reportedNanoUsd(0)).toBe(0);
    expect(reportedNanoUsd(1e-9)).toBe(1);
  });

  it.each([undefined, -0.1, Number.NaN, Number.POSITIVE_INFINITY, 1e12, '0.5' as never])(
    'is undefined for %s',
    (value) => {
      expect(reportedNanoUsd(value)).toBeUndefined();
    },
  );
});

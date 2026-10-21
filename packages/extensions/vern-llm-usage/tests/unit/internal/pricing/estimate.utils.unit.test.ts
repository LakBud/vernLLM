import { describe, expect, it } from 'vitest';

import { estimateNanoUsd } from '../../../../src/internal/pricing/estimate.utils.js';

const price = {
  input: 2_000,
  output: 10_000,
  reasoning: 10_000,
  cacheRead: 2_000,
  cacheWrite: 2_000,
};

describe('estimateNanoUsd', () => {
  it('prices input at the input rate and output at the output rate', () => {
    expect(estimateNanoUsd(100, 50, price as never)).toBe(100 * 2_000 + 50 * 10_000);
  });

  it('prices output at the reasoning rate when that is dearer', () => {
    expect(estimateNanoUsd(0, 10, { ...price, reasoning: 30_000 } as never)).toBe(300_000);
  });
});

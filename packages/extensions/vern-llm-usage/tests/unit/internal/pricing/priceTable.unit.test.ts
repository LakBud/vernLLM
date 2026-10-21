import { describe, expect, it, vi } from 'vitest';

import { normalizePrices } from '../../../../src/internal/options/normalizePrices.utils.js';
import { PriceTable } from '../../../../src/internal/pricing/priceTable.js';

const table = (
  prices: Record<string, { input: number; output: number }>,
  normalizeModel?: (model: string) => string,
) => new PriceTable({ prices: normalizePrices(prices), priceFor: undefined, normalizeModel });

describe('PriceTable lookup from a table', () => {
  const prices = {
    'gpt-6': { input: 1, output: 1 },
    'bedrock/gpt-6': { input: 2, output: 2 },
  };

  it('prefers the target scoped key, then falls back to the model key', () => {
    expect(table(prices).lookup('gpt-6', 'bedrock')?.input).toBe(2_000);
    expect(table(prices).lookup('gpt-6', 'primary')?.input).toBe(1_000);
    expect(table(prices).lookup('gpt-6', undefined)?.input).toBe(1_000);
  });

  it('never matches by prefix, so gpt-6 cannot silently price gpt-6-mini', () => {
    expect(table(prices).lookup('gpt-6-mini', 'primary')).toBeUndefined();
  });

  it('applies normalizeModel before the lookup, to the model and not the target', () => {
    const lookup = table(prices, (model) => model.replace(/-\d{4}-\d{2}-\d{2}$/, ''));

    expect(lookup.lookup('gpt-6-2026-10-01', 'bedrock')?.input).toBe(2_000);
  });

  it('returns undefined for an unknown model', () => {
    expect(table(prices).lookup('claude-sonnet-5-5', 'primary')).toBeUndefined();
  });
});

describe('PriceTable lookup through priceFor', () => {
  it('asks priceFor with the raw model and the target, and nothing else', () => {
    const priceFor = vi.fn(() => ({ input: 3, output: 3 }));
    const lookup = new PriceTable({
      prices: normalizePrices({ 'gpt-6': { input: 1, output: 1 } }),
      priceFor,
      normalizeModel: (model) => model.toUpperCase(),
    });

    expect(lookup.lookup('gpt-6', 'bedrock')?.input).toBe(3_000);
    expect(priceFor).toHaveBeenCalledWith('gpt-6', 'bedrock');
  });

  it("asks priceFor for the 'primary' target when the usage names no provider", () => {
    const priceFor = vi.fn(() => ({ input: 3, output: 3 }));
    const lookup = new PriceTable({
      prices: undefined,
      priceFor,
      normalizeModel: undefined,
    });

    lookup.lookup('gpt-6', undefined);

    expect(priceFor).toHaveBeenCalledWith('gpt-6', 'primary');
  });

  it('converts a returned object once, however often it comes back', () => {
    const price = { input: 3, output: 3 };
    const lookup = new PriceTable({
      prices: undefined,
      priceFor: () => price,
      normalizeModel: undefined,
    });

    expect(lookup.lookup('m', 'p')).toBe(lookup.lookup('m', 'p'));
  });

  it('returns undefined when priceFor does, and throws on an invalid price', () => {
    const none = new PriceTable({
      prices: undefined,
      priceFor: () => undefined,
      normalizeModel: undefined,
    });
    const bad = new PriceTable({
      prices: undefined,
      priceFor: () => ({ input: -1, output: 1 }),
      normalizeModel: undefined,
    });

    expect(none.lookup('m', 'p')).toBeUndefined();
    expect(() => bad.lookup('m', 'p')).toThrow(
      'priceFor result.input must be a finite number >= 0',
    );
  });
});

import { describe, expect, it } from 'vitest';

import { assertValidAimd } from '../../../../src/internal/rate-limit/aimd.utils.js';

describe('assertValidAimd', () => {
  it('accepts a well-formed config', () => {
    expect(() =>
      assertValidAimd({ increaseBy: 1, decreaseFactor: 0.5, minCapacity: 1, maxCapacity: 10 }, 10),
    ).not.toThrow();
  });

  it('throws when requestsPerMinute is not set', () => {
    expect(() =>
      assertValidAimd(
        { increaseBy: 1, decreaseFactor: 0.5, minCapacity: 1, maxCapacity: 10 },
        undefined,
      ),
    ).toThrow(/requestsPerMinute/);
  });

  it('throws when requestsPerMinute is 0, the same as undefined', () => {
    expect(() =>
      assertValidAimd({ increaseBy: 1, decreaseFactor: 0.5, minCapacity: 1, maxCapacity: 10 }, 0),
    ).toThrow(/requestsPerMinute/);
  });

  it('throws when minCapacity is below 1', () => {
    expect(() =>
      assertValidAimd({ increaseBy: 1, decreaseFactor: 0.5, minCapacity: 0, maxCapacity: 10 }, 10),
    ).toThrow(/at least 1/);
  });

  it('throws when maxCapacity is below 1', () => {
    expect(() =>
      assertValidAimd({ increaseBy: 1, decreaseFactor: 0.5, minCapacity: 1, maxCapacity: 0 }, 10),
    ).toThrow(/at least 1/);
  });

  it('throws when minCapacity exceeds maxCapacity', () => {
    expect(() =>
      assertValidAimd({ increaseBy: 1, decreaseFactor: 0.5, minCapacity: 10, maxCapacity: 5 }, 10),
    ).toThrow(/minCapacity/);
  });

  it('accepts minCapacity equal to maxCapacity, a fixed non-adaptive ceiling', () => {
    expect(() =>
      assertValidAimd({ increaseBy: 1, decreaseFactor: 0.5, minCapacity: 10, maxCapacity: 10 }, 10),
    ).not.toThrow();
  });

  it('throws when decreaseFactor is 0 or below', () => {
    expect(() =>
      assertValidAimd({ increaseBy: 1, decreaseFactor: 0, minCapacity: 1, maxCapacity: 10 }, 10),
    ).toThrow(/decreaseFactor/);
  });

  it('throws when decreaseFactor exceeds 1', () => {
    expect(() =>
      assertValidAimd({ increaseBy: 1, decreaseFactor: 1.5, minCapacity: 1, maxCapacity: 10 }, 10),
    ).toThrow(/decreaseFactor/);
  });

  it('accepts decreaseFactor of exactly 1, a ceiling that never shrinks', () => {
    expect(() =>
      assertValidAimd({ increaseBy: 1, decreaseFactor: 1, minCapacity: 1, maxCapacity: 10 }, 10),
    ).not.toThrow();
  });

  it('throws when increaseBy is 0 or negative', () => {
    expect(() =>
      assertValidAimd({ increaseBy: 0, decreaseFactor: 0.5, minCapacity: 1, maxCapacity: 10 }, 10),
    ).toThrow(/increaseBy/);
    expect(() =>
      assertValidAimd({ increaseBy: -1, decreaseFactor: 0.5, minCapacity: 1, maxCapacity: 10 }, 10),
    ).toThrow(/increaseBy/);
  });

  it('throws when increaseBy is not finite', () => {
    expect(() =>
      assertValidAimd(
        { increaseBy: Infinity, decreaseFactor: 0.5, minCapacity: 1, maxCapacity: 10 },
        10,
      ),
    ).toThrow(/increaseBy/);
    expect(() =>
      assertValidAimd(
        { increaseBy: NaN, decreaseFactor: 0.5, minCapacity: 1, maxCapacity: 10 },
        10,
      ),
    ).toThrow(/increaseBy/);
  });

  it('accepts a config with no proactiveFloor set', () => {
    expect(() =>
      assertValidAimd({ increaseBy: 1, decreaseFactor: 0.5, minCapacity: 1, maxCapacity: 10 }, 10),
    ).not.toThrow();
  });

  it('accepts proactiveFloor of 0, meaning off', () => {
    expect(() =>
      assertValidAimd(
        { increaseBy: 1, decreaseFactor: 0.5, minCapacity: 1, maxCapacity: 10, proactiveFloor: 0 },
        10,
      ),
    ).not.toThrow();
  });

  it('throws when proactiveFloor is negative', () => {
    expect(() =>
      assertValidAimd(
        { increaseBy: 1, decreaseFactor: 0.5, minCapacity: 1, maxCapacity: 10, proactiveFloor: -1 },
        10,
      ),
    ).toThrow(/proactiveFloor/);
  });

  it('throws when proactiveFloor is not finite', () => {
    expect(() =>
      assertValidAimd(
        {
          increaseBy: 1,
          decreaseFactor: 0.5,
          minCapacity: 1,
          maxCapacity: 10,
          proactiveFloor: Infinity,
        },
        10,
      ),
    ).toThrow(/proactiveFloor/);
  });
});

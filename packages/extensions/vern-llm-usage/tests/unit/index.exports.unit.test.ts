import { describe, expect, it } from 'vitest';

import * as entry from '../../src/index.js';

describe('package entrypoint exports', () => {
  it('exports exactly the documented runtime surface', () => {
    // An exact list, so an internal helper can never become public by accident.
    expect(Object.keys(entry).sort()).toEqual([
      'memoryUsageStore',
      'usageBudgetKey',
      'usageBudgetShare',
      'usageLogFields',
      'usageMiddleware',
      'usageMiddlewareRef',
    ]);
  });

  it('names the ref after the package', () => {
    expect(entry.usageMiddlewareRef.debugName).toBe('usage');
  });

  it('exports the option types, usable together as documented', () => {
    const price: entry.ModelPrice = { input: 1.25, output: 10, cacheWrite: { '5m': 3.75 } };
    const options: entry.UsageMiddlewareOptions = {
      prices: { 'gpt-6-sol': price },
      pricesAsOf: '2026-10-01',
      logger: 'silent',
    };

    expect(entry.usageMiddleware(options).name).toBe('usage');
  });
});

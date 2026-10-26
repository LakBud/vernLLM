import { describe, expect, it } from 'vitest';

import * as api from '../../src/index.js';

describe('public exports', () => {
  it('exports the middleware factory, ref, events, dimensions, log fields and default targets', () => {
    expect(Object.keys(api).sort()).toEqual([
      'HEDGE_ADAPT_EVENT',
      'HEDGE_DECISION_EVENT',
      'hedgeDimension',
      'hedgeLogFields',
      'hedgeMiddleware',
      'hedgeMiddlewareRef',
      'nextTargets',
      'promptSizeDimension',
    ]);
    expect(api.HEDGE_DECISION_EVENT).toBe('hedge.decision');
    expect(api.HEDGE_ADAPT_EVENT).toBe('hedge.adapt');
  });
});

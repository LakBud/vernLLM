import { describe, expect, it } from 'vitest';

import * as api from '../../src/index.js';

describe('public exports', () => {
  it('exports the middleware factory, ref, event name and state key', () => {
    expect(Object.keys(api).sort()).toEqual([
      'ROUTER_DECISION_EVENT',
      'driftDimension',
      'routeDimension',
      'routerMiddleware',
      'routerMiddlewareRef',
      'routerRouteKey',
    ]);
    expect(api.ROUTER_DECISION_EVENT).toBe('router.decision');
  });
});

import { describe, expect, it } from 'vitest';

import * as pkg from '../../src/index.js';

describe('the public surface', () => {
  it('exports exactly what the package documents', () => {
    expect(Object.keys(pkg).sort()).toEqual([
      'GUARD_RESULT_EVENT',
      'guardLabels',
      'guardLogFields',
      'guardMiddleware',
      'guardMiddlewareRef',
      'keywords',
      'patterns',
    ]);
  });

  it('names the middleware and sits outside policy and usage', () => {
    const guard = pkg.guardMiddleware({ version: 'v1', checks: [] });
    expect(guard.name).toBe('guard');
    expect(guard.position).toBe(-150);
    expect(guard.ref).toBe(pkg.guardMiddlewareRef);
    expect(pkg.GUARD_RESULT_EVENT).toBe('guard.result');
  });
});

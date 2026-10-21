import { describe, expect, it } from 'vitest';

import { loggerMiddleware, loggerMiddlewareRef } from '../../src/index.js';

describe('loggerMiddleware', () => {
  it('registers under the module level ref, outermost, with the default name', () => {
    const middleware = loggerMiddleware();

    expect(middleware.name).toBe('logger');
    expect(middleware.ref).toBe(loggerMiddlewareRef);
    expect(middleware.position).toBe('outermost');
  });

  it('takes its name from the options', () => {
    expect(loggerMiddleware({ name: 'calls' }).name).toBe('calls');
  });

  it('never sets a priority or an enabled function', () => {
    const middleware = loggerMiddleware();

    // A function `enabled` would make the core deliver events asynchronously.
    expect(middleware.enabled).toBeUndefined();
    expect(middleware.priority).toBeUndefined();
  });

  it('throws at construction on a bad option, not on the first call', () => {
    expect(() => loggerMiddleware({ level: 'loud' as never })).toThrow(
      'loggerMiddleware: level must be one of',
    );
  });

  it('creates independent instances that share one ref', () => {
    const a = loggerMiddleware();
    const b = loggerMiddleware();

    expect(a).not.toBe(b);
    expect(a.ref).toBe(b.ref);
  });
});

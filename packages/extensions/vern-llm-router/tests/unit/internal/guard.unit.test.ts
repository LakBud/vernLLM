import { describe, expect, it } from 'vitest';

import { createGuard } from '../../../src/internal/guard.utils.js';
import { captureLogger } from '../../helpers.js';

describe('createGuard', () => {
  it('returns the fallback and reports a throw', () => {
    const log = captureLogger();
    const guard = createGuard(log.logger);
    expect(
      guard(
        'op',
        () => {
          throw 'plain';
        },
        7,
      ),
    ).toBe(7);
    expect(log.errors()[0]).toBe('[VernLLM] router: op failed');
  });

  it('warns a keyed message once', () => {
    const log = captureLogger();
    const guard = createGuard(log.logger);
    guard.warnOnce('k', 'hello');
    guard.warnOnce('k', 'hello');
    expect(log.warnings()).toEqual(['[VernLLM] router: hello']);
  });

  it('is silent when asked, and defaults to a console logger', () => {
    const silent = createGuard('silent');
    expect(() => {
      silent.report('op', new Error('x'));
      silent.warn('w');
    }).not.toThrow();
    expect(createGuard(undefined)).toBeTypeOf('function');
  });
});

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
    expect(log.errors()[0]).toBe('[VernLLM] policy: op failed');
  });

  it('returns the value when nothing throws', () => {
    expect(createGuard('silent')('op', () => 3, 7)).toBe(3);
  });

  it('warns a keyed message once', () => {
    const log = captureLogger();
    const guard = createGuard(log.logger);
    guard.warnOnce('k', 'hello');
    guard.warnOnce('k', 'hello');
    expect(log.warnings()).toEqual(['[VernLLM] policy: hello']);
  });

  it('is silent when asked, and defaults to a console logger', () => {
    const silent = createGuard('silent');
    expect(() => {
      silent.report('op', new Error('x'));
      silent.warn('w');
    }).not.toThrow();
    expect(createGuard(undefined)).toBeTypeOf('function');
  });

  it('survives a logger that throws', () => {
    const guard = createGuard({
      debug: () => undefined,
      warn: () => {
        throw new Error('logger down');
      },
      error: () => {
        throw new Error('logger down');
      },
    });
    expect(() => {
      guard.report('op', new Error('x'));
      guard.warn('w');
    }).not.toThrow();
  });
});

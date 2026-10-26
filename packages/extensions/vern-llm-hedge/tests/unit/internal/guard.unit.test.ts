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
    expect(log.errors()).toEqual(['[VernLLM] hedge: op failed']);
  });

  it('returns what the function returns when it does not throw', () => {
    expect(createGuard('silent')('op', () => 3, 7)).toBe(3);
  });

  it('warns a keyed message once', () => {
    const log = captureLogger();
    const guard = createGuard(log.logger);

    guard.warnOnce('k', 'hello');
    guard.warnOnce('k', 'hello');
    guard.warnOnce('other', 'again');

    expect(log.warnings()).toEqual(['[VernLLM] hedge: hello', '[VernLLM] hedge: again']);
  });

  it('is silent when asked, and defaults to a console logger', () => {
    const silent = createGuard('silent');

    expect(() => {
      silent.report('op', new Error('x'));
      silent.warn('w');
      silent.warnOnce('k', 'w');
    }).not.toThrow();
    expect(createGuard(undefined)).toBeTypeOf('function');
  });

  it('survives a logger that throws', () => {
    const guard = createGuard({
      debug: () => {},
      warn: () => {
        throw new Error('broken');
      },
      error: () => {
        throw new Error('broken');
      },
    });

    expect(() => {
      guard.report('op', new Error('x'));
      guard.warn('w');
      guard(
        'op',
        () => {
          throw new Error('x');
        },
        1,
      );
    }).not.toThrow();
  });
});

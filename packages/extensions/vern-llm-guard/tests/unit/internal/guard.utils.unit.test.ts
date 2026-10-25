import { describe, expect, it } from 'vitest';

import { createGuard } from '../../../src/internal/guard.utils.js';
import { captureLogger } from '../../helpers.js';

describe('createGuard', () => {
  it('reports a failure under the name of the operation', () => {
    const log = captureLogger();
    createGuard(log.logger).report('op', new Error('boom'));
    expect(log.errors()).toEqual(['[VernLLM] guard: op failed']);
  });

  it('reports a value that is not an error', () => {
    const log = captureLogger();
    createGuard(log.logger).report('op', 'plain text');
    expect(log.errors()).toEqual(['[VernLLM] guard: op failed']);
  });

  it('warns a keyed message once', () => {
    const log = captureLogger();
    const guard = createGuard(log.logger);
    guard.warnOnce('k', 'hello');
    guard.warnOnce('k', 'hello');
    expect(log.warnings()).toEqual(['[VernLLM] guard: hello']);
  });

  it('is silent when asked, and defaults to a console logger', () => {
    const silent = createGuard('silent');
    expect(() => {
      silent.report('op', new Error('x'));
      silent.warn('w');
    }).not.toThrow();
    expect(createGuard(undefined).warnOnce).toBeTypeOf('function');
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

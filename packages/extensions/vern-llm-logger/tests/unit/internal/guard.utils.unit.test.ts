import { describe, expect, it, vi } from 'vitest';

import { createGuard } from '../../../src/internal/guard.utils.js';

function recordingLogger() {
  return { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('createGuard', () => {
  it('returns the result of fn untouched', () => {
    expect(createGuard('silent')('op', () => 42, 0)).toBe(42);
  });

  it('returns the fallback and logs the shared line shape when fn throws', () => {
    const logger = recordingLogger();
    const boom = new Error('boom');
    const result = createGuard(logger)(
      'sink',
      () => {
        throw boom;
      },
      'fallback',
    );

    expect(result).toBe('fallback');
    expect(logger.error).toHaveBeenCalledWith('[VernLLM] logger: sink failed', {
      message: 'boom',
      stack: boom.stack,
    });
  });

  it('logs a thrown non error value as a string with no stack', () => {
    const logger = recordingLogger();
    createGuard(logger)(
      'op',
      () => {
        throw 'plain';
      },
      undefined,
    );

    expect(logger.error).toHaveBeenCalledWith('[VernLLM] logger: op failed', {
      message: 'plain',
      stack: undefined,
    });
  });

  it('hands a returned promise back untouched, so a rejection is not swallowed', async () => {
    const rejected = Promise.reject(new Error('later'));
    const result = createGuard('silent')('op', () => rejected, Promise.resolve('x'));

    expect(result).toBe(rejected);
    await expect(result).rejects.toThrow('later');
  });

  it('reports and warns with the package prefix', () => {
    const logger = recordingLogger();
    const guard = createGuard(logger);

    guard.report('flush', new Error('bad'));
    guard.warn('series cap reached');

    expect(logger.error).toHaveBeenCalledWith('[VernLLM] logger: flush failed', expect.anything());
    expect(logger.warn).toHaveBeenCalledWith('[VernLLM] logger: series cap reached');
  });

  it('stays silent when asked to', () => {
    const guard = createGuard('silent');
    expect(() => {
      guard.report('op', new Error('x'));
      guard.warn('x');
    }).not.toThrow();
  });

  it('survives a logger that throws', () => {
    const logger = {
      debug: vi.fn(),
      warn: vi.fn(() => {
        throw new Error('warn broke');
      }),
      error: vi.fn(() => {
        throw new Error('error broke');
      }),
    };
    const guard = createGuard(logger);

    expect(
      guard(
        'op',
        () => {
          throw new Error('inner');
        },
        7,
      ),
    ).toBe(7);
    expect(() => guard.warn('x')).not.toThrow();
  });

  it('falls back to a console logger when none is given', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    createGuard(undefined).report('op', new Error('x'));
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

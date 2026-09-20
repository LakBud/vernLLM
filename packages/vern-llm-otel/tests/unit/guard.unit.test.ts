import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGuard } from '../../src/guard.js';

function recordingLogger() {
  return { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createGuard', () => {
  it('returns the result of fn untouched', () => {
    const guard = createGuard('silent');
    expect(guard('op', () => 42, 0)).toBe(42);
  });

  it('returns the fallback and logs the shared line shape when fn throws', () => {
    const logger = recordingLogger();
    const guard = createGuard(logger);
    const boom = new Error('boom');

    expect(
      guard(
        'startCall',
        () => {
          throw boom;
        },
        'fallback',
      ),
    ).toBe('fallback');

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith('[VernLLM] otel: startCall failed', {
      message: 'boom',
      stack: boom.stack,
    });
  });

  it('logs a thrown non error value as a string with no stack', () => {
    const logger = recordingLogger();
    const guard = createGuard(logger);

    guard(
      'op',
      () => {
        throw 'plain string';
      },
      undefined,
    );

    expect(logger.error).toHaveBeenCalledWith('[VernLLM] otel: op failed', {
      message: 'plain string',
      stack: undefined,
    });
  });

  it("logs nothing when the logger is 'silent'", () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const guard = createGuard('silent');

    expect(
      guard(
        'op',
        () => {
          throw new Error('x');
        },
        1,
      ),
    ).toBe(1);
    expect(spy).not.toHaveBeenCalled();
  });

  it('defaults to a console logger', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const guard = createGuard(undefined);

    guard(
      'op',
      () => {
        throw new Error('x');
      },
      1,
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe('[VernLLM] otel: op failed');
  });

  it('survives a logger that throws', () => {
    const guard = createGuard({
      debug: () => {},
      warn: () => {},
      error: () => {
        throw new Error('logger down');
      },
    });

    expect(
      guard(
        'op',
        () => {
          throw new Error('x');
        },
        'safe',
      ),
    ).toBe('safe');
  });

  it('hands a returned promise back without swallowing its rejection', async () => {
    const logger = recordingLogger();
    const guard = createGuard(logger);
    const failure = new Error('caller error');

    const result = guard('op', () => Promise.reject(failure), Promise.resolve());

    await expect(result).rejects.toBe(failure);
    expect(logger.error).not.toHaveBeenCalled();
  });

  describe('report', () => {
    it('logs without running anything', () => {
      const logger = recordingLogger();
      const guard = createGuard(logger);

      guard.report('when', new Error('returned a promise'));

      expect(logger.error).toHaveBeenCalledWith(
        '[VernLLM] otel: when failed',
        expect.objectContaining({ message: 'returned a promise' }),
      );
    });

    it('survives a value whose string conversion throws', () => {
      const logger = recordingLogger();
      const guard = createGuard(logger);
      const hostile = {
        toString() {
          throw new Error('no string for you');
        },
      };

      expect(() => guard.report('op', hostile)).not.toThrow();
    });

    it('does nothing when silent', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      createGuard('silent').report('op', new Error('x'));
      expect(spy).not.toHaveBeenCalled();
    });
  });
});

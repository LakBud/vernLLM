import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGuard } from '../../../src/internal/guard.utils.js';

import type { Logger } from 'vern-llm';

const recordingLogger = () => {
  const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() } satisfies Logger;
  return logger;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createGuard', () => {
  it('returns the value of what it runs', () => {
    expect(createGuard('silent')('op', () => 7, 0)).toBe(7);
  });

  it('returns the fallback and logs when what it runs throws', () => {
    const logger = recordingLogger();
    const guard = createGuard(logger);

    expect(
      guard(
        'op',
        () => {
          throw new Error('boom');
        },
        'fallback',
      ),
    ).toBe('fallback');
    expect(logger.error).toHaveBeenCalledWith('[VernLLM] usage: op failed', {
      message: 'boom',
      stack: expect.any(String),
    });
  });

  it('logs something that is not an Error by its string form, with no stack', () => {
    const logger = recordingLogger();

    createGuard(logger).report('op', 'plain text');

    expect(logger.error).toHaveBeenCalledWith('[VernLLM] usage: op failed', {
      message: 'plain text',
      stack: undefined,
    });
  });

  it('logs a configuration warning', () => {
    const logger = recordingLogger();

    createGuard(logger).warn('check the prices');

    expect(logger.warn).toHaveBeenCalledWith('[VernLLM] usage: check the prices');
  });

  it('writes to the console when no logger is given', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const guard = createGuard(undefined);

    guard.report('op', new Error('x'));
    guard.warn('careful');

    expect(error).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith('[VernLLM] usage: careful');
  });

  it('says nothing when silent', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const guard = createGuard('silent');

    guard.report('op', new Error('x'));
    guard.warn('careful');

    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('is not broken by a logger that throws', () => {
    const logger = {
      debug: vi.fn(),
      warn: () => {
        throw new Error('warn broke');
      },
      error: () => {
        throw new Error('error broke');
      },
    } satisfies Logger;
    const guard = createGuard(logger);

    expect(
      guard(
        'op',
        () => {
          throw new Error('boom');
        },
        1,
      ),
    ).toBe(1);
    expect(() => guard.warn('x')).not.toThrow();
  });
});

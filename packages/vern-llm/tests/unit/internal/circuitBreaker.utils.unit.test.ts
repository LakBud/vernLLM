import { describe, expect, it, vi } from 'vitest';

import {
  resolveExecutor,
  warnIfModelUnsupported,
} from '../../../src/internal/circuitBreaker.utils.js';

import type { CallExecutor } from '../../../src/internal/execution/callExecutor.js';
import type { Logger } from '../../../src/logger.js';

function fakeExecutor(providerName: string): CallExecutor {
  return { providerName } as unknown as CallExecutor;
}

function fakeLogger(): Logger {
  return { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('resolveExecutor', () => {
  it('returns the executor at the given index', () => {
    const primary = fakeExecutor('primary');
    const fallback = fakeExecutor('fallback');

    expect(resolveExecutor([primary, fallback], 0, 'caller')).toBe(primary);
    expect(resolveExecutor([primary, fallback], 1, 'caller')).toBe(fallback);
  });

  it('throws a RangeError naming the caller when the index has no target', () => {
    const primary = fakeExecutor('primary');

    expect(() => resolveExecutor([primary], 5, 'getCircuitState')).toThrow(RangeError);
    expect(() => resolveExecutor([primary], 5, 'getCircuitState')).toThrow(/getCircuitState/);
  });

  it('pluralizes the target count correctly in the error message', () => {
    const primary = fakeExecutor('primary');

    expect(() => resolveExecutor([primary], 5, 'caller')).toThrow(/1 target\)/);
    expect(() => resolveExecutor([primary, fakeExecutor('b')], 5, 'caller')).toThrow(/2 targets\)/);
  });

  it('throws for a negative index too', () => {
    const primary = fakeExecutor('primary');

    expect(() => resolveExecutor([primary], -1, 'caller')).toThrow(RangeError);
  });
});

describe('warnIfModelUnsupported', () => {
  it('does nothing when model is undefined', () => {
    const logger = fakeLogger();

    warnIfModelUnsupported(false, undefined, 'caller', logger);

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does nothing when the target isolates by model', () => {
    const logger = fakeLogger();

    warnIfModelUnsupported(true, 'gpt-4o', 'caller', logger);

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns, naming the caller and the model, when a model is given but the target does not isolate by model', () => {
    const logger = fakeLogger();

    warnIfModelUnsupported(false, 'gpt-4o', 'openCircuit', logger);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [message] = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(message).toContain('openCircuit');
    expect(message).toContain('gpt-4o');
    expect(message).toContain('isolateByModel');
  });
});

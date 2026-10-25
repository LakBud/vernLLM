import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  budgetFor,
  DetectorTimeoutError,
  withTimeout,
} from '../../../../src/internal/scan/timeout.utils.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('budgetFor', () => {
  it('is the check limit when the call has no deadline', () => {
    expect(budgetFor(2000, undefined)).toBe(2000);
  });

  it('never runs past the deadline of the call', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1000);
    expect(budgetFor(2000, 1500)).toBe(500);
    expect(budgetFor(200, 1500)).toBe(200);
  });

  it('is zero when the deadline has passed', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1000);
    expect(budgetFor(2000, 900)).toBe(0);
  });
});

describe('withTimeout', () => {
  it('passes on the answer of a detector that is in time', async () => {
    const controller = new AbortController();
    await expect(withTimeout(Promise.resolve([{ segment: 0 }]), 100, controller)).resolves.toEqual([
      { segment: 0 },
    ]);
    expect(controller.signal.aborted).toBe(false);
  });

  it('passes on the failure of a detector that is in time', async () => {
    await expect(
      withTimeout(Promise.reject(new Error('boom')), 100, new AbortController()),
    ).rejects.toThrow('boom');
  });

  it('aborts a detector that is too slow and rejects with a timeout error', async () => {
    const controller = new AbortController();
    const never = new Promise<never>(() => {});

    await expect(withTimeout(never, 5, controller)).rejects.toBeInstanceOf(DetectorTimeoutError);
    expect(controller.signal.aborted).toBe(true);
  });
});

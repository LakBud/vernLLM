import { describe, expect, it } from 'vitest';

import { isSlow } from '../../../../src/internal/detectors/slowCall.utils.js';

import type { CallLogRecord } from '../../../../src/index.js';

const record = (durationMs: number) => ({ durationMs }) as CallLogRecord;
const none = { thresholdMs: undefined, aboveLivePercentile: undefined };

describe('isSlow', () => {
  it('is off when neither rule is set', () => {
    expect(isSlow(record(1e9), none, () => 1)).toBe(false);
  });

  it('flags a call over the threshold, and not one at it', () => {
    const rule = { ...none, thresholdMs: 100 };

    expect(isSlow(record(101), rule, () => undefined)).toBe(true);
    expect(isSlow(record(100), rule, () => undefined)).toBe(false);
  });

  it('flags a call over the live percentile once there is one', () => {
    const rule = { ...none, aboveLivePercentile: 0.99 };

    expect(isSlow(record(500), rule, () => 400)).toBe(true);
    expect(isSlow(record(300), rule, () => 400)).toBe(false);
    expect(isSlow(record(1e9), rule, () => undefined)).toBe(false);
  });

  it('does not read the percentile when the threshold already decided', () => {
    let reads = 0;
    const rule = { thresholdMs: 10, aboveLivePercentile: 0.9 };
    isSlow(record(50), rule, () => (reads++, 1));

    expect(reads).toBe(0);
  });
});

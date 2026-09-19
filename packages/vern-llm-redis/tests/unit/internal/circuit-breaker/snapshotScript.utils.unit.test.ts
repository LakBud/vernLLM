import { describe, expect, it } from 'vitest';

import { parseSnapshotResult } from '../../../../src/internal/circuit-breaker/snapshotScript.js';

describe('parseSnapshotResult', () => {
  it('parses a bucket read into a typed entry', () => {
    expect(parseSnapshotResult(['cb:m', 'open', '5', '123456'])).toEqual({
      key: 'cb:m',
      state: 'open',
      failures: 5,
      openedAt: 123456,
    });
  });

  it.each([null, undefined, false, 0, ''])('returns null for a key that is gone (%s)', (raw) => {
    expect(parseSnapshotResult(raw)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';

import { parseSnapshotResult } from '../../../../../src/internal/circuit-breaker/scripts/snapshotScript.js';

describe('parseSnapshotResult', () => {
  it('parses a bucket read into a typed entry', () => {
    expect(parseSnapshotResult(['cb:m', 'open', '5', '123456', '42'])).toEqual({
      key: 'cb:m',
      state: 'open',
      failures: 5,
      openedAt: 123456,
      version: 42,
    });
  });

  it.each([undefined, '0', 'x'])(
    'reads a version of %s as 0, a hash never versioned',
    (version) => {
      expect(parseSnapshotResult(['cb:m', 'open', '5', '1', version])?.version).toBe(0);
    },
  );

  it.each([null, undefined, false, 0, ''])('returns null for a key that is gone (%s)', (raw) => {
    expect(parseSnapshotResult(raw)).toBeNull();
  });
});

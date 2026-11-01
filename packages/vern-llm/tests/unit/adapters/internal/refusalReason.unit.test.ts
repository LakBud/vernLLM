import { describe, expect, it } from 'vitest';

import { refusalReason } from '../../../../src/adapters/internal/refusalReason.js';

const reasons = new Set(['refusal', 'SAFETY']);

describe('refusalReason', () => {
  it('returns the matched reason as the refusal', () => {
    expect(refusalReason('SAFETY', reasons)).toEqual({ refusal: 'SAFETY' });
  });

  it.each([['end_turn'], [''], [null], [undefined]])(
    'returns nothing for %s, so the spread adds no key',
    (reason) => {
      expect(refusalReason(reason, reasons)).toEqual({});
    },
  );
});

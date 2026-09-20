import { describe, expect, it } from 'vitest';

import { sanitizeAttributes } from '../../../../src/internal/attributes/sanitize.utils.js';

describe('sanitizeAttributes', () => {
  it('keeps strings, booleans, finite numbers, and homogeneous arrays', () => {
    expect(
      sanitizeAttributes({
        'app.tenant': 'acme',
        'app.flag': false,
        'app.count': 0,
        'app.tags': ['a', 'b'],
        'app.scores': [1, 2.5],
        'app.bits': [true, false],
        'app.empty': [],
      }),
    ).toEqual({
      'app.tenant': 'acme',
      'app.flag': false,
      'app.count': 0,
      'app.tags': ['a', 'b'],
      'app.scores': [1, 2.5],
      'app.bits': [true, false],
      'app.empty': [],
    });
  });

  it('drops anything OpenTelemetry cannot carry, without stringifying it', () => {
    expect(
      sanitizeAttributes({
        nested: { secret: 'x' },
        nothing: null,
        missing: undefined,
        nan: Number.NaN,
        inf: Number.POSITIVE_INFINITY,
        big: 10n,
        fn: () => 1,
        sym: Symbol('s'),
        mixed: [1, 'a'],
        withNull: ['a', null],
        badNumbers: [1, Number.NaN],
        [' ']: 'kept because only an empty key is invalid',
        '': 'dropped',
      }),
    ).toEqual({ ' ': 'kept because only an empty key is invalid' });
  });

  it.each([undefined, null, 'string', 5, true, ['a'], () => ({})])(
    'returns an empty bag for a non object (%s)',
    (value) => {
      expect(sanitizeAttributes(value)).toEqual({});
    },
  );
});

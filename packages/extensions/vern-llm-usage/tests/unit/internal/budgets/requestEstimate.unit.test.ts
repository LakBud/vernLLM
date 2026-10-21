import { describe, expect, it } from 'vitest';

import { estimateAnswerTokens } from '../../../../src/internal/budgets/requestEstimate.js';

describe('estimateAnswerTokens', () => {
  it('counts a string as it is, four characters a token, rounded up', () => {
    expect(estimateAnswerTokens('abcd')).toBe(1);
    expect(estimateAnswerTokens('abcde')).toBe(2);
    expect(estimateAnswerTokens('')).toBe(0);
  });

  it('counts anything else as its JSON', () => {
    // '{"a":1}' is 7 characters.
    expect(estimateAnswerTokens({ a: 1 })).toBe(2);
  });

  it('counts nothing for a value with no JSON form', () => {
    expect(estimateAnswerTokens(undefined)).toBe(0);
    expect(estimateAnswerTokens(() => 1)).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';

import {
  parseTransitionMessage,
  parseTransitionResult,
} from '../../../../src/internal/circuit-breaker/transitionScript.js';

describe('parseTransitionResult', () => {
  it('parses a real transition', () => {
    expect(parseTransitionResult(['closed', 'open', '5'])).toEqual({
      from: 'closed',
      to: 'open',
      failures: 5,
    });
  });

  it('parses a no-op check, from and to identical', () => {
    expect(parseTransitionResult(['closed', 'closed', '0'])).toEqual({
      from: 'closed',
      to: 'closed',
      failures: 0,
    });
  });

  it('coerces the string-encoded failures field to a number', () => {
    expect(parseTransitionResult(['open', 'half-open', '12']).failures).toBe(12);
  });
});

describe('parseTransitionMessage', () => {
  it('parses a well-formed pub/sub message', () => {
    expect(parseTransitionMessage('cb:gpt-4o|open|3|123456')).toEqual({
      key: 'cb:gpt-4o',
      state: 'open',
      failures: 3,
      openedAt: 123456,
    });
  });

  it('parses a shared (non isolated) key with no model suffix', () => {
    expect(parseTransitionMessage('cb|closed|0|0')).toEqual({
      key: 'cb',
      state: 'closed',
      failures: 0,
      openedAt: 0,
    });
  });

  it('returns undefined for an empty message', () => {
    expect(parseTransitionMessage('')).toBeUndefined();
  });

  it('returns undefined for a message missing its state field', () => {
    expect(parseTransitionMessage('cb|')).toBeUndefined();
  });

  it('returns undefined for a message with no separators at all', () => {
    expect(parseTransitionMessage('garbage')).toBeUndefined();
  });
});

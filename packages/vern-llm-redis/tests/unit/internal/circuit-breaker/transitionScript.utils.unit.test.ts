import { describe, expect, it } from 'vitest';

import {
  parseTransitionMessage,
  parseTransitionResult,
} from '../../../../src/internal/circuit-breaker/transitionScript.js';

describe('parseTransitionResult', () => {
  it('parses a real transition', () => {
    expect(parseTransitionResult(['closed', 'open', '5', '0'])).toEqual({
      from: 'closed',
      to: 'open',
      failures: 5,
      wonProbe: false,
    });
  });

  it('parses a no-op check, from and to identical', () => {
    expect(parseTransitionResult(['closed', 'closed', '0', '0'])).toEqual({
      from: 'closed',
      to: 'closed',
      failures: 0,
      wonProbe: false,
    });
  });

  it('coerces the string-encoded failures field to a number', () => {
    expect(parseTransitionResult(['open', 'half-open', '12', '1']).failures).toBe(12);
  });

  it('parses wonProbe as true only for a "1" flag', () => {
    expect(parseTransitionResult(['open', 'half-open', '0', '1']).wonProbe).toBe(true);
    expect(parseTransitionResult(['half-open', 'half-open', '0', '0']).wonProbe).toBe(false);
  });
});

describe('parseTransitionMessage', () => {
  it('parses a well-formed pub/sub message', () => {
    expect(
      parseTransitionMessage(
        JSON.stringify({ key: 'cb:gpt-4o', state: 'open', failures: 3, openedAt: 123456 }),
      ),
    ).toEqual({
      key: 'cb:gpt-4o',
      state: 'open',
      failures: 3,
      openedAt: 123456,
    });
  });

  it('parses a shared (non isolated) key with no model suffix', () => {
    expect(
      parseTransitionMessage(
        JSON.stringify({ key: 'cb', state: 'closed', failures: 0, openedAt: 0 }),
      ),
    ).toEqual({
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
    expect(parseTransitionMessage(JSON.stringify({ key: 'cb' }))).toBeUndefined();
  });

  it('returns undefined for a message with an invalid state value', () => {
    expect(
      parseTransitionMessage(
        JSON.stringify({ key: 'cb', state: 'bogus', failures: 0, openedAt: 0 }),
      ),
    ).toBeUndefined();
  });

  it('returns undefined for a message that is not valid JSON', () => {
    expect(parseTransitionMessage('garbage')).toBeUndefined();
  });
});

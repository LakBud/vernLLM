import { describe, expect, it } from 'vitest';

import {
  parseTransitionMessage,
  parseTransitionResult,
} from '../../../../src/internal/circuit-breaker/transitionScript.js';

describe('parseTransitionResult', () => {
  it('parses a real transition', () => {
    expect(parseTransitionResult(['closed', 'open', '5', '0', '123456'])).toEqual({
      from: 'closed',
      to: 'open',
      failures: 5,
      wonProbe: false,
      openedAt: 123456,
    });
  });

  it('parses a no-op check, from and to identical', () => {
    expect(parseTransitionResult(['closed', 'closed', '0', '0', '0'])).toEqual({
      from: 'closed',
      to: 'closed',
      failures: 0,
      wonProbe: false,
      openedAt: 0,
    });
  });

  it('coerces the string-encoded failures field to a number', () => {
    expect(parseTransitionResult(['open', 'half-open', '12', '1', '0']).failures).toBe(12);
  });

  it('parses wonProbe as true only for a "1" flag', () => {
    expect(parseTransitionResult(['open', 'half-open', '0', '1', '0']).wonProbe).toBe(true);
    expect(parseTransitionResult(['half-open', 'half-open', '0', '0', '0']).wonProbe).toBe(false);
  });

  it('coerces the string-encoded openedAt field to a number', () => {
    expect(parseTransitionResult(['closed', 'open', '1', '0', '789']).openedAt).toBe(789);
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

  it('returns undefined when the parsed JSON is not an object', () => {
    expect(parseTransitionMessage('5')).toBeUndefined();
    expect(parseTransitionMessage('"a string"')).toBeUndefined();
    expect(parseTransitionMessage('null')).toBeUndefined();
    expect(parseTransitionMessage('[1,2,3]')).toBeUndefined();
  });

  it('returns undefined when key is missing or not a string', () => {
    expect(
      parseTransitionMessage(JSON.stringify({ state: 'open', failures: 0, openedAt: 0 })),
    ).toBeUndefined();
    expect(
      parseTransitionMessage(JSON.stringify({ key: 5, state: 'open', failures: 0, openedAt: 0 })),
    ).toBeUndefined();
    expect(
      parseTransitionMessage(JSON.stringify({ key: '', state: 'open', failures: 0, openedAt: 0 })),
    ).toBeUndefined();
  });

  it('returns undefined when failures is missing or not a finite number', () => {
    expect(
      parseTransitionMessage(JSON.stringify({ key: 'cb', state: 'open', openedAt: 0 })),
    ).toBeUndefined();
    expect(
      parseTransitionMessage(
        JSON.stringify({ key: 'cb', state: 'open', failures: 'oops', openedAt: 0 }),
      ),
    ).toBeUndefined();
    expect(
      parseTransitionMessage(
        JSON.stringify({ key: 'cb', state: 'open', failures: Infinity, openedAt: 0 }),
      ),
    ).toBeUndefined();
  });

  it('returns undefined when openedAt is missing or not a finite number', () => {
    expect(
      parseTransitionMessage(JSON.stringify({ key: 'cb', state: 'open', failures: 0 })),
    ).toBeUndefined();
    expect(
      parseTransitionMessage(
        JSON.stringify({ key: 'cb', state: 'open', failures: 0, openedAt: 'oops' }),
      ),
    ).toBeUndefined();
    expect(
      parseTransitionMessage(
        JSON.stringify({ key: 'cb', state: 'open', failures: 0, openedAt: NaN }),
      ),
    ).toBeUndefined();
  });
});

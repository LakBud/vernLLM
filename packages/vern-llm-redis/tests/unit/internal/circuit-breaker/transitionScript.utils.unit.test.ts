import { describe, expect, it } from 'vitest';

import {
  parseTransitionMessage,
  parseTransitionResult,
} from '../../../../src/internal/circuit-breaker/transitionScript.js';

/** The four fields a reply carries after the breakdown: Redis's clock, cooldown, lease time and free slots. */
const TIMING = ['5000', '30000', '4000', '2'];

describe('parseTransitionResult', () => {
  it('parses a real transition', () => {
    expect(
      parseTransitionResult(['closed', 'open', '5', '0', '123456', '', '', ...TIMING]),
    ).toEqual({
      from: 'closed',
      to: 'open',
      failures: 5,
      wonProbe: false,
      openedAt: 123456,
      probeToken: '',
      breakdown: {},
      serverNow: 5000,
      cooldownMs: 30000,
      grantAt: 4000,
      slots: 2,
    });
  });

  it('parses a no-op check, from and to identical', () => {
    expect(
      parseTransitionResult(['closed', 'closed', '0', '0', '0', '', '', ...TIMING]),
    ).toMatchObject({ from: 'closed', to: 'closed', failures: 0, wonProbe: false, openedAt: 0 });
  });

  it('coerces the string encoded numbers to numbers', () => {
    const parsed = parseTransitionResult([
      'open',
      'half-open',
      '12',
      '1',
      '789',
      '',
      '',
      ...TIMING,
    ]);

    expect([parsed.failures, parsed.openedAt, parsed.serverNow, parsed.cooldownMs]).toEqual([
      12, 789, 5000, 30000,
    ]);
  });

  it('parses wonProbe as true only for a "1" flag', () => {
    expect(
      parseTransitionResult(['open', 'half-open', '0', '1', '0', '3', '', ...TIMING]).wonProbe,
    ).toBe(true);
    expect(
      parseTransitionResult(['half-open', 'half-open', '0', '0', '0', '', '', ...TIMING]).wonProbe,
    ).toBe(false);
  });

  it('reads the probe token, defaulting to empty when the reply has none', () => {
    expect(
      parseTransitionResult(['open', 'half-open', '0', '1', '0', '7', '', ...TIMING]).probeToken,
    ).toBe('7');
    expect(
      parseTransitionResult(['open', 'half-open', '0', '1', '0', undefined, '', ...TIMING])
        .probeToken,
    ).toBe('');
  });
});

describe('parseTransitionMessage', () => {
  const full = {
    key: 'cb:gpt-4o',
    state: 'open',
    failures: 3,
    openedAt: 123456,
    now: 5000,
    cooldown: 30000,
    slots: 0,
    grantAt: 0,
  };

  it('parses a well-formed pub/sub message', () => {
    expect(parseTransitionMessage(JSON.stringify(full))).toEqual({
      key: 'cb:gpt-4o',
      state: 'open',
      failures: 3,
      openedAt: 123456,
      serverNow: 5000,
      cooldownMs: 30000,
      slots: 0,
      grantAt: 0,
    });
  });

  it('parses a shared (non isolated) key with no model suffix', () => {
    expect(
      parseTransitionMessage(JSON.stringify({ ...full, key: 'cb', state: 'closed' })),
    ).toMatchObject({ key: 'cb', state: 'closed' });
  });

  it.each(['failures', 'openedAt', 'now', 'cooldown', 'slots', 'grantAt'])(
    'returns undefined when %s is missing or not a finite number',
    (field) => {
      expect(
        parseTransitionMessage(JSON.stringify({ ...full, [field]: undefined })),
      ).toBeUndefined();
      expect(parseTransitionMessage(JSON.stringify({ ...full, [field]: 'x' }))).toBeUndefined();
      expect(parseTransitionMessage(JSON.stringify({ ...full, [field]: null }))).toBeUndefined();
    },
  );

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

describe('parseTransitionResult breakdown parsing', () => {
  const parse = (breakdown: unknown) =>
    parseTransitionResult(['closed', 'closed', '0', '0', '0', '', breakdown]).breakdown;

  it('reads code=count pairs', () => {
    expect(parse('request_timeout=2,unknown=1')).toEqual({ request_timeout: 2, unknown: 1 });
  });

  it('skips malformed pairs instead of throwing: no equals sign, empty code, non numeric count', () => {
    expect(parse('noequals,=5,a=notanumber,b=2')).toEqual({ b: 2 });
  });

  it.each(['', undefined, 5, null])('yields an empty breakdown for %s', (raw) => {
    expect(parse(raw)).toEqual({});
  });
});

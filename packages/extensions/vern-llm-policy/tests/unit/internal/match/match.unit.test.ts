import { describe, expect, it } from 'vitest';

import { LabelsUnknownError, PatternError } from '../../../../src/internal/match/errors.js';
import { compileMatcher } from '../../../../src/internal/match/match.utils.js';
import { patternKeys } from '../../../../src/internal/match/patternKeys.utils.js';
import { isPlainObject, isScalar } from '../../../../src/internal/match/value.utils.js';

/** Target patterns compare flat attributes. */
const flat = (pattern: unknown) => compileMatcher(pattern, 'p', { nested: false });
/** Call patterns may nest, as `context` and `request` do. */
const nested = (pattern: unknown) => compileMatcher(pattern, 'p', { nested: true });

describe('compileMatcher', () => {
  describe('a single key', () => {
    it('equals a scalar strictly', () => {
      const match = flat({ region: 'eu' });
      expect(match({ region: 'eu' })).toBe(true);
      expect(match({ region: 'us' })).toBe(false);
    });

    it('does not coerce between types', () => {
      expect(flat({ port: 1 })({ port: '1' })).toBe(false);
      expect(flat({ port: 1 })({ port: 1 })).toBe(true);
      expect(flat({ zdr: true })({ zdr: 'true' })).toBe(false);
      expect(flat({ zdr: true })({ zdr: true })).toBe(true);
      expect(flat({ zdr: false })({ zdr: false })).toBe(true);
    });

    it('matches any of a list', () => {
      const match = flat({ region: ['eu', 'uk'] });
      expect(match({ region: 'uk' })).toBe(true);
      expect(match({ region: 'us' })).toBe(false);
    });
  });

  describe('several keys', () => {
    it('needs every one to match', () => {
      const match = flat({ region: 'eu', zdr: true });
      expect(match({ region: 'eu', zdr: true })).toBe(true);
      expect(match({ region: 'eu', zdr: false })).toBe(false);
      expect(match({ region: 'us', zdr: true })).toBe(false);
    });
  });

  describe('missing facts', () => {
    it('never equal anything', () => {
      expect(flat({ region: 'eu' })({})).toBe(false);
      expect(flat({ region: ['eu', 'us'] })({})).toBe(false);
      expect(flat({ zdr: false })({})).toBe(false);
    });

    it('are caught by not, which is how a rule reaches undeclared targets', () => {
      expect(flat({ not: { region: 'eu' } })({})).toBe(true);
      expect(flat({ not: { region: 'eu' } })({ region: 'eu' })).toBe(false);
      expect(flat({ not: { region: 'eu' } })({ region: 'us' })).toBe(true);
    });

    it('read own properties only, so an inherited value is not a fact', () => {
      const facts = Object.create({ region: 'eu' }) as object;
      expect(flat({ region: 'eu' })(facts)).toBe(false);
    });

    it('are missing when the facts are not an object at all', () => {
      expect(flat({ region: 'eu' })(undefined)).toBe(false);
      expect(flat({ region: 'eu' })('eu')).toBe(false);
      expect(flat({ region: 'eu' })(null)).toBe(false);
    });
  });

  describe('not and any', () => {
    it('not inverts a pattern', () => {
      const match = flat({ not: { zdr: true } });
      expect(match({ zdr: false })).toBe(true);
      expect(match({ zdr: true })).toBe(false);
    });

    it('any needs one of its patterns', () => {
      const match = flat({ any: [{ region: 'eu' }, { selfHosted: true }] });
      expect(match({ region: 'eu' })).toBe(true);
      expect(match({ selfHosted: true })).toBe(true);
      expect(match({ region: 'us' })).toBe(false);
    });

    it('combine with other keys and with each other', () => {
      const match = flat({ zdr: true, not: { any: [{ region: 'us' }, { region: 'cn' }] } });
      expect(match({ zdr: true, region: 'eu' })).toBe(true);
      expect(match({ zdr: true, region: 'cn' })).toBe(false);
      expect(match({ zdr: false, region: 'eu' })).toBe(false);
    });
  });

  describe('functions', () => {
    it('match only when they return exactly true', () => {
      expect(flat((facts: { n: number }) => facts.n > 1)({ n: 2 })).toBe(true);
      expect(flat((facts: { n: number }) => facts.n > 1)({ n: 1 })).toBe(false);
      expect(flat(() => 1 as unknown as boolean)({})).toBe(false);
      expect(flat(() => 'yes' as unknown as boolean)({})).toBe(false);
    });

    it('work inside not and any', () => {
      expect(flat({ not: () => true })({})).toBe(false);
      expect(flat({ any: [() => false, { region: 'eu' }] })({ region: 'eu' })).toBe(true);
    });

    it('let a throw through, for the caller to decide', () => {
      const match = flat(() => {
        throw new Error('boom');
      });
      expect(() => match({})).toThrow('boom');
    });
  });

  describe('nested patterns', () => {
    it('match inside a fact that is an object', () => {
      const match = nested({ context: { plan: 'free', tier: ['a', 'b'] } });
      expect(match({ context: { plan: 'free', tier: 'a' } })).toBe(true);
      expect(match({ context: { plan: 'free', tier: 'c' } })).toBe(false);
      expect(match({ context: { plan: 'pro', tier: 'a' } })).toBe(false);
    });

    it('never match a fact that is absent, and not matches it', () => {
      expect(nested({ context: { plan: 'free' } })({})).toBe(false);
      expect(nested({ context: { not: { plan: 'free' } } })({})).toBe(true);
    });

    it('bound a number with gte and lte', () => {
      const match = nested({ request: { inputTokens: { gte: 100, lte: 200 } } });
      expect(match({ request: { inputTokens: 100 } })).toBe(true);
      expect(match({ request: { inputTokens: 200 } })).toBe(true);
      expect(match({ request: { inputTokens: 99 } })).toBe(false);
      expect(match({ request: { inputTokens: 201 } })).toBe(false);
      expect(match({ request: { inputTokens: '150' } })).toBe(false);
      expect(match({ request: {} })).toBe(false);
    });

    it('take either bound alone, and combine them with any', () => {
      expect(nested({ n: { gte: 5 } })({ n: 5 })).toBe(true);
      expect(nested({ n: { lte: 5 } })({ n: 6 })).toBe(false);
      const either = nested({ n: { any: [{ lte: 1 }, { gte: 10 }] } });
      expect(either({ n: 0 })).toBe(true);
      expect(either({ n: 5 })).toBe(false);
      expect(either({ n: 11 })).toBe(true);
    });

    it('are refused where patterns compare flat attributes', () => {
      expect(() => flat({ region: { eu: true } })).toThrow(
        'must be a string, number, boolean or a list of them',
      );
    });

    it('say a nested pattern is allowed where one is', () => {
      expect(() => nested({ context: null })).toThrow('or a nested pattern');
    });
  });

  describe('a pattern that can never work', () => {
    it.each([
      ['an empty pattern, which would match everything', {}, 'at least one key'],
      ['a string instead of a pattern', 'eu', 'must be a pattern'],
      ['null', null, 'must be a pattern'],
      ['an array instead of a pattern', [{ region: 'eu' }], 'must be a pattern'],
      ['a null value', { region: null }, 'must be a string, number, boolean'],
      ['an undefined value', { region: undefined }, 'must be a string, number, boolean'],
      ['NaN', { n: Number.NaN }, 'must be a string, number, boolean'],
      ['Infinity', { n: Number.POSITIVE_INFINITY }, 'must be a string, number, boolean'],
      ['an empty list', { region: [] }, 'non empty list'],
      ['a list holding a non scalar', { region: ['eu', {}] }, 'non empty list'],
      ['a function as a key value', { region: () => true }, 'must be a string, number, boolean'],
      ['any that is not a list', { any: { region: 'eu' } }, 'non empty list of patterns'],
      ['any with no patterns', { any: [] }, 'non empty list of patterns'],
      ['not holding a scalar', { not: 'eu' }, 'must be a pattern'],
      ['a bound at the top, where no number is', { gte: 1 }, 'belongs inside a fact'],
    ])('rejects %s', (_label, pattern, message) => {
      expect(() => flat(pattern)).toThrow(PatternError);
      expect(() => flat(pattern)).toThrow(message);
    });

    it('rejects a bound that is not a finite number', () => {
      expect(() => nested({ n: { gte: '1' } })).toThrow('must be a finite number');
      expect(() => nested({ n: { lte: Number.NaN } })).toThrow('must be a finite number');
    });

    it('names the path to the mistake', () => {
      expect(() =>
        compileMatcher({ any: [{ region: 'eu' }, { zdr: {} }] }, 'rule "x" forbid', {
          nested: false,
        }),
      ).toThrow('rule "x" forbid.any[1].zdr');
    });

    it('rejects a pattern nested past the limit, including a cyclic one', () => {
      let deep: Record<string, unknown> = { region: 'eu' };
      for (let i = 0; i < 12; i++) deep = { not: deep };
      expect(() => flat(deep)).toThrow('levels deep');

      const cyclic: Record<string, unknown> = {};
      cyclic.not = cyclic;
      expect(() => flat(cyclic)).toThrow('levels deep');
    });

    it('accepts a pattern right at the limit', () => {
      let deep: Record<string, unknown> = { region: 'eu' };
      for (let i = 0; i < 8; i++) deep = { not: deep };
      expect(() => flat(deep)).not.toThrow();
    });
  });
});

describe('patternKeys', () => {
  it('lists the fact names read at the top level', () => {
    expect(patternKeys({ region: 'eu', zdr: true })).toEqual(['region', 'zdr']);
  });

  it('looks through not and any', () => {
    expect(patternKeys({ not: { region: 'eu' }, any: [{ a: 1 }, { not: { b: 2 } }] })).toEqual([
      'region',
      'a',
      'b',
    ]);
  });

  it('skips functions, which are opaque, and anything that is not a pattern', () => {
    expect(patternKeys(() => true)).toEqual([]);
    expect(patternKeys({ not: () => true, any: [() => true] })).toEqual([]);
    expect(patternKeys('eu')).toEqual([]);
    expect(patternKeys(null)).toEqual([]);
    expect(patternKeys([])).toEqual([]);
  });

  it('ignores invalid not and any values', () => {
    expect(patternKeys({ not: null, any: { region: 'eu' } })).toEqual([]);
  });

  it('leaves out the bounds, which are not fact names', () => {
    expect(patternKeys({ gte: 1, lte: 2 })).toEqual([]);
  });

  it('does not take the keys inside a nested fact for fact names', () => {
    expect(patternKeys({ context: { plan: 'free' } })).toEqual(['context']);
  });
});

describe('isScalar and isPlainObject', () => {
  it('accept strings, booleans and finite numbers only', () => {
    expect([isScalar('a'), isScalar(0), isScalar(false)]).toEqual([true, true, true]);
    expect([isScalar(null), isScalar(undefined), isScalar(Number.NaN), isScalar({})]).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it('tell an object from an array and null', () => {
    expect([isPlainObject({}), isPlainObject([]), isPlainObject(null), isPlainObject('x')]).toEqual(
      [true, false, false, false],
    );
  });
});

describe('the labels fact', () => {
  const pii = nested({ labels: 'pii' });

  it('matches when the label is present', () => {
    expect(pii({ labels: ['pii', 'health'] })).toBe(true);
    expect(pii({ labels: ['health'] })).toBe(false);
  });

  it('does not match when the labels are known and empty', () => {
    expect(pii({ labels: [] })).toBe(false);
  });

  it('wants every label of a list', () => {
    const both = nested({ labels: ['pii', 'health'] });
    expect(both({ labels: ['health', 'pii', 'other'] })).toBe(true);
    expect(both({ labels: ['pii'] })).toBe(false);
  });

  it('throws when the labels are unknown, rather than answering', () => {
    expect(() => pii({})).toThrow(LabelsUnknownError);
    expect(() => pii({ labels: 'pii' })).toThrow('the labels are unknown');
  });

  it('throws through not, so unknown labels never read as "no pii"', () => {
    expect(() => nested({ not: { labels: 'pii' } })({})).toThrow(LabelsUnknownError);
  });

  it('is skipped when another key already settled the answer', () => {
    const match = nested({ context: { tenant: 'acme' }, labels: 'pii' });
    expect(match({ context: { tenant: 'other' } })).toBe(false);
    expect(() => match({ context: { tenant: 'acme' } })).toThrow(LabelsUnknownError);
  });

  it('is an ordinary key inside context, and in a target pattern', () => {
    expect(nested({ context: { labels: 'x' } })({ context: { labels: 'x' } })).toBe(true);
    expect(flat({ labels: 'x' })({ labels: 'x' })).toBe(true);
  });
});

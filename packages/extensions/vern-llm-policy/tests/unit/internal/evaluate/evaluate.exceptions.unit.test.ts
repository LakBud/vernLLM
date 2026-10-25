import { describe, expect, it } from 'vitest';

import { NOW, call, decide, permutations } from './evaluateHelpers.js';

import type { PolicyException, PolicyRule } from '../../../../src/index.js';

const acme = { tenant: 'acme' };
const boom = (): never => {
  throw new Error('boom');
};

const exception = (overrides: Partial<PolicyException> = {}): PolicyException => ({
  when: { context: { tenant: 'acme' } },
  until: '2026-11-01',
  reason: 'DPA signed',
  ...overrides,
});

const euOnly = (except: PolicyException[]): PolicyRule => ({
  id: 'eu-residency',
  forbid: { not: { region: 'eu' } },
  except,
});

describe('an exception', () => {
  it('lifts the rule for the calls it covers, and is recorded with its reason', () => {
    const decision = decide([euOnly([exception()])], {}, call(acme));

    expect(decision.outcome).toBe('allowed');
    expect(decision.removed).toEqual({});
    expect(decision.exceptions).toEqual([
      { rule: 'eu-residency', reason: 'DPA signed', until: '2026-11-01' },
    ]);
  });

  it('leaves the rule in force for a call it does not cover, and records nothing', () => {
    const decision = decide([euOnly([exception()])], {}, call({ tenant: 'other' }));

    expect(decision.removed).toEqual({ us: 'eu-residency' });
    expect(decision.exceptions).toEqual([]);
  });

  describe('that has expired', () => {
    const end = Date.UTC(2026, 10, 1);
    const rules = [euOnly([exception()])];

    it('is active up to the last millisecond before it ends', () => {
      expect(decide(rules, {}, call(acme), undefined, end - 1).removed).toEqual({});
    });

    it('is ignored from the moment it ends, and not recorded', () => {
      const decision = decide(rules, {}, call(acme), undefined, end);
      expect(decision.removed).toEqual({ us: 'eu-residency' });
      expect(decision.exceptions).toEqual([]);
    });

    it('reads a date and time with an offset as that instant', () => {
      const timed = [euOnly([exception({ until: '2026-11-01T12:00:00+01:00' })])];
      const instant = Date.UTC(2026, 10, 1, 11);
      expect(decide(timed, {}, call(acme), undefined, instant - 1).removed).toEqual({});
      expect(decide(timed, {}, call(acme), undefined, instant).removed).toEqual({
        us: 'eu-residency',
      });
    });
  });

  it('is not recorded when the rule it sits on did not apply anyway', () => {
    const rule: PolicyRule = {
      ...euOnly([exception()]),
      when: { context: { region: 'eu' } },
    };
    expect(decide([rule], {}, call(acme)).exceptions).toEqual([]);
  });

  it('lifts only its own rule, so another forbid still wins', () => {
    const decision = decide(
      [euOnly([exception()]), { id: 'no-local', forbid: { name: 'local' } }],
      {},
      call(acme),
    );
    expect(decision.removed).toEqual({ local: 'no-local' });
  });

  it('lifts an allow, so the default decides again', () => {
    const rule: PolicyRule = { id: 'only-eu', allow: { region: 'eu' }, except: [exception()] };

    expect(decide([rule], {}, call(acme)).outcome).toBe('allowed');
    expect(decide([rule], { default: 'deny' }, call(acme)).removed).toEqual({
      us: 'default',
      eu: 'default',
      local: 'default',
    });
  });

  it('takes the flags of the rule with it', () => {
    const rule: PolicyRule = {
      id: 'a',
      set: { logContent: false },
      except: [exception()],
    };
    expect(decide([rule], {}, call(acme)).flags).toEqual({});
    expect(decide([rule], {}, call({ tenant: 'other' })).flags).toEqual({ logContent: false });
  });

  it('is not recorded for an audit rule, which changes nothing either way', () => {
    const rule: PolicyRule = { ...euOnly([exception()]), mode: 'audit' };

    const covered = decide([rule], {}, call(acme));
    expect(covered.audit).toEqual({});
    expect(covered.exceptions).toEqual([]);

    expect(decide([rule], {}, call({ tenant: 'other' })).audit).toEqual({
      'eu-residency': ['us'],
    });
  });

  it('can cover with a function', () => {
    const rule = euOnly([exception({ when: (facts) => facts.context?.tenant === 'acme' })]);
    expect(decide([rule], {}, call(acme)).removed).toEqual({});
  });

  it('records every exception that covers a rule, sorted', () => {
    const decision = decide(
      [
        euOnly([
          exception({ until: '2026-12-01', reason: 'b' }),
          exception({ until: '2026-11-01', reason: 'z' }),
          exception({ until: '2026-11-01', reason: 'a' }),
        ]),
        { id: 'another', forbid: { name: 'us' }, except: [exception({ reason: 'r' })] },
      ],
      {},
      call(acme),
    );

    expect(decision.exceptions).toEqual([
      { rule: 'another', reason: 'r', until: '2026-11-01' },
      { rule: 'eu-residency', reason: 'a', until: '2026-11-01' },
      { rule: 'eu-residency', reason: 'z', until: '2026-11-01' },
      { rule: 'eu-residency', reason: 'b', until: '2026-12-01' },
    ]);
  });

  describe('whose when throws', () => {
    const rules = [euOnly([exception({ when: boom })])];

    it.each(['closed', 'open'] as const)(
      'covers nothing when %s, so a way past a rule never opens by accident',
      (onError) => {
        const decision = decide(rules, { onError }, call(acme));
        expect(decision.removed).toEqual({ us: 'eu-residency' });
        expect(decision.exceptions).toEqual([]);
        expect(decision.errors).toEqual([{ rule: 'eu-residency', name: 'Error', message: 'boom' }]);
      },
    );

    it('does not stop a working exception beside it', () => {
      const decision = decide(
        [euOnly([exception({ when: boom }), exception({ reason: 'works' })])],
        {},
        call(acme),
      );
      expect(decision.removed).toEqual({});
      expect(decision.exceptions).toEqual([
        { rule: 'eu-residency', reason: 'works', until: '2026-11-01' },
      ]);
      expect(decision.errors).toHaveLength(1);
    });
  });

  it('is not tried when the rule is already skipped by an allow that throws when closed', () => {
    const rule: PolicyRule = {
      id: 'a',
      allow: { region: 'eu' },
      when: boom,
      except: [exception({ when: boom })],
    };
    const decision = decide([rule], { onError: 'closed' }, call(acme));
    expect(decision.errors).toEqual([{ rule: 'a', name: 'Error', message: 'boom' }]);
    expect(decision.exceptions).toEqual([]);
  });

  it('gives one decision for every ordering of the rules', () => {
    const rules: PolicyRule[] = [
      euOnly([exception(), exception({ until: '2020-01-01', reason: 'old' })]),
      { id: 'no-local', forbid: { name: 'local' }, except: [exception({ when: boom })] },
      { id: 'flag', set: { logContent: false }, except: [exception({ reason: 'x' })] },
      { id: 'audited', forbid: { name: 'eu' }, mode: 'audit' },
    ];
    const expected = decide(rules, {}, call(acme));
    expect(expected.exceptions.length).toBeGreaterThan(0);
    expect(expected.errors.length).toBeGreaterThan(0);

    for (const ordering of permutations(rules)) {
      expect(decide(ordering, {}, call(acme))).toEqual(expected);
    }
  });

  it('uses the instant it is given, not the clock, so a decision can be replayed', () => {
    expect(NOW).toBeLessThan(Date.UTC(2026, 10, 1));
    expect(decide([euOnly([exception()])], {}, call(acme)).removed).toEqual({});
  });
});

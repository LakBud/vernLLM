import { describe, expect, it } from 'vitest';

import { all, call, decide, eu, local, permutations, target, us } from './evaluateHelpers.js';

import type { CallFacts, PolicyRule } from '../../../../src/index.js';

describe('evaluate', () => {
  describe('with no applicable allow', () => {
    it('allows every target by default', () => {
      const decision = decide([]);
      expect(decision).toEqual({
        outcome: 'allowed',
        allowed: ['us', 'eu', 'local'],
        removed: {},
        rules: [],
        audit: {},
        errors: [],
        flags: {},
        flagCauses: {},
        exceptions: [],
      });
    });

    it('allows nothing under default deny, naming the default', () => {
      const decision = decide([], { default: 'deny' });
      expect(decision).toEqual({
        outcome: 'denied',
        allowed: [],
        removed: { us: 'default', eu: 'default', local: 'default' },
        rules: [],
        audit: {},
        errors: [],
        flags: {},
        flagCauses: {},
        exceptions: [],
      });
    });
  });

  describe('allow', () => {
    it('lets only the targets it matches through, and names itself for the rest', () => {
      const decision = decide([{ id: 'eu-only', allow: { region: 'eu' } }]);
      expect(decision.outcome).toBe('narrowed');
      expect(decision.allowed).toEqual(['eu', 'local']);
      expect(decision.removed).toEqual({ us: 'eu-only' });
      expect(decision.rules).toEqual(['eu-only']);
    });

    it('widens with another allow, since they union', () => {
      const decision = decide([
        { id: 'eu', allow: { region: 'eu' } },
        { id: 'us', allow: { name: 'us' } },
      ]);
      expect(decision.allowed).toEqual(['us', 'eu', 'local']);
      expect(decision.outcome).toBe('allowed');
    });

    it('makes the default irrelevant once a rule allows', () => {
      const allow: PolicyRule = { id: 'a', allow: { name: 'us' } };
      expect(decide([allow], { default: 'allow' }).allowed).toEqual(['us']);
      expect(decide([allow], { default: 'deny' }).allowed).toEqual(['us']);
    });

    it('does nothing while its when does not match, so the default applies', () => {
      const allow: PolicyRule = {
        id: 'free',
        allow: { name: 'us' },
        when: { context: { plan: 'free' } },
      };
      expect(decide([allow], {}, call({ plan: 'pro' })).allowed).toEqual(['us', 'eu', 'local']);
      expect(decide([allow], { default: 'deny' }, call({ plan: 'pro' })).outcome).toBe('denied');
      expect(decide([allow], {}, call({ plan: 'free' })).allowed).toEqual(['us']);
    });

    it('denies when no target matches, naming the allow rule rather than the default', () => {
      const decision = decide([{ id: 'only-x', allow: { name: 'x' } }]);
      expect(decision.outcome).toBe('denied');
      expect(decision.rules).toEqual(['only-x']);
      expect(decision.removed).toEqual({ us: 'only-x', eu: 'only-x', local: 'only-x' });
    });

    it('names the smallest id when several allow rules leave a target out', () => {
      const decision = decide([
        { id: 'zeta', allow: { name: 'eu' } },
        { id: 'alpha', allow: { name: 'local' } },
      ]);
      expect(decision.removed).toEqual({ us: 'alpha' });
    });
  });

  describe('forbid', () => {
    it('removes the targets it matches', () => {
      const decision = decide([{ id: 'no-us', forbid: { region: 'us' } }]);
      expect(decision).toEqual({
        outcome: 'narrowed',
        allowed: ['eu', 'local'],
        removed: { us: 'no-us' },
        rules: ['no-us'],
        audit: {},
        errors: [],
        flags: {},
        flagCauses: {},
        exceptions: [],
      });
    });

    it('beats an allow that matches the same target', () => {
      const decision = decide([
        { id: 'allow-all-eu', allow: { region: 'eu' } },
        { id: 'no-local', forbid: { selfHosted: true } },
      ]);
      expect(decision.allowed).toEqual(['eu']);
      expect(decision.removed).toEqual({ us: 'allow-all-eu', local: 'no-local' });
    });

    it('beats the default, and a forbid is named over a missing allow', () => {
      const decision = decide([
        { id: 'a-allow', allow: { name: 'eu' } },
        { id: 'z-forbid', forbid: { name: 'us' } },
      ]);
      expect(decision.removed).toEqual({ us: 'z-forbid', local: 'a-allow' });
    });

    it('reaches targets that declare nothing when written with not', () => {
      const bare = target('bare');
      const decision = decide(
        [{ id: 'eu-residency', forbid: { not: { region: 'eu' } } }],
        {},
        call(),
        [...all, bare],
      );
      expect(decision.allowed).toEqual(['eu', 'local']);
      expect(decision.removed).toEqual({ us: 'eu-residency', bare: 'eu-residency' });
    });

    it('does not reach a target that declares nothing when written as a plain match', () => {
      const bare = target('bare');
      const decision = decide([{ id: 'no-us', forbid: { region: 'us' } }], {}, call(), [bare]);
      expect(decision.allowed).toEqual(['bare']);
    });

    it('removes everything with forbid all, and denies', () => {
      const decision = decide(
        [{ id: 'suspended', forbid: 'all', when: { context: { status: 'suspended' } } }],
        {},
        call({ status: 'suspended' }),
      );
      expect(decision.outcome).toBe('denied');
      expect(decision.rules).toEqual(['suspended']);
      expect(decision.allowed).toEqual([]);
      expect(
        decide(
          [{ id: 'suspended', forbid: 'all', when: { context: { status: 'suspended' } } }],
          {},
          call({ status: 'ok' }),
        ).outcome,
      ).toBe('allowed');
    });

    it('names the smallest id when several forbids remove one target', () => {
      const decision = decide([
        { id: 'zebra', forbid: { name: 'us' } },
        { id: 'apple', forbid: { region: 'us' } },
        { id: 'mango', forbid: { zdr: false } },
      ]);
      expect(decision.removed).toEqual({ us: 'apple' });
      expect(decision.rules).toEqual(['apple']);
    });
  });

  describe('when', () => {
    it('reads the call facts', () => {
      const rule: PolicyRule = {
        id: 'tools',
        forbid: { name: 'us' },
        when: { request: { hasTools: true } },
      };
      const withTools: CallFacts = { ...call(), request: { ...call().request, hasTools: true } };
      expect(decide([rule], {}, call()).outcome).toBe('allowed');
      expect(decide([rule], {}, withTools).allowed).toEqual(['eu', 'local']);
    });
  });

  describe('the result', () => {
    it('is a subset of the targets, in the order they came in', () => {
      const reversed = [local, us, eu];
      const decision = decide([{ id: 'no-us', forbid: { region: 'us' } }], {}, call(), reversed);
      expect(decision.allowed).toEqual(['local', 'eu']);
    });

    it('keeps a target named __proto__ as plain data in removed', () => {
      const odd = target('__proto__', { region: 'us' });
      const decision = decide([{ id: 'no-us', forbid: { region: 'us' } }], {}, call(), [odd, eu]);
      expect(Object.hasOwn(decision.removed, '__proto__')).toBe(true);
      expect(decision.allowed).toEqual(['eu']);
    });
  });

  describe('rule order', () => {
    const rules: PolicyRule[] = [
      { id: 'eu-first', allow: { region: 'eu' } },
      { id: 'also-us', allow: { name: 'us' }, when: { context: { plan: 'free' } } },
      { id: 'no-local', forbid: { selfHosted: true } },
      { id: 'no-nonzdr-pii', forbid: { zdr: false }, when: { context: { data: 'pii' } } },
      { id: 'zz-no-us', forbid: { region: 'us' } },
    ];

    it.each([
      ['a free plan with pii', call({ plan: 'free', data: 'pii' })],
      ['a free plan', call({ plan: 'free' })],
      ['pii only', call({ data: 'pii' })],
      ['nothing in particular', call()],
    ])('gives one decision for every ordering of the rules: %s', (_label, facts) => {
      const expected = decide(rules, {}, facts);

      const orderings = permutations(rules);
      expect(orderings).toHaveLength(120);
      for (const ordering of orderings) {
        expect(decide(ordering, {}, facts)).toEqual(expected);
      }
    });

    it('gives one decision for every ordering under default deny', () => {
      const expected = decide(rules, { default: 'deny' });
      for (const ordering of permutations(rules)) {
        expect(decide(ordering, { default: 'deny' })).toEqual(expected);
      }
    });
  });
});

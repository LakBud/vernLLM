import { describe, expect, it } from 'vitest';

import { call, decide, permutations } from './evaluateHelpers.js';

import type { PolicyRule } from '../../../../src/index.js';

const boom = (): never => {
  throw new Error('boom');
};

describe('an audit rule', () => {
  it('reports the targets it would remove and removes none', () => {
    const decision = decide([{ id: 'a', forbid: { region: 'us' }, mode: 'audit' }]);
    expect(decision.outcome).toBe('allowed');
    expect(decision.allowed).toEqual(['us', 'eu', 'local']);
    expect(decision.removed).toEqual({});
    expect(decision.rules).toEqual([]);
    expect(decision.audit).toEqual({ a: ['us'] });
  });

  it('leaves the entry out when it would remove nothing', () => {
    const decision = decide([{ id: 'a', forbid: { region: 'asia' }, mode: 'audit' }]);
    expect(decision.audit).toEqual({});
  });

  it('never denies a call, even when it would remove every target', () => {
    const decision = decide([{ id: 'a', forbid: { name: ['us', 'eu', 'local'] }, mode: 'audit' }]);
    expect(decision.outcome).toBe('allowed');
    expect(decision.audit).toEqual({ a: ['us', 'eu', 'local'] });
  });

  it('does not report a target an enforced rule already removes', () => {
    const decision = decide([
      { id: 'enforced', forbid: { name: 'us' } },
      { id: 'a', forbid: { region: 'us' }, mode: 'audit' },
    ]);
    expect(decision.removed).toEqual({ us: 'enforced' });
    expect(decision.audit).toEqual({});
  });

  it('reports what an allow would leave out', () => {
    const decision = decide([{ id: 'a', allow: { region: 'eu' }, mode: 'audit' }]);
    expect(decision.allowed).toEqual(['us', 'eu', 'local']);
    expect(decision.audit).toEqual({ a: ['us'] });
  });

  it('never reports a target through an allow that only widens what is enforced', () => {
    const decision = decide([
      { id: 'enforced', allow: { name: 'eu' } },
      { id: 'a', allow: { name: 'us' }, mode: 'audit' },
    ]);
    expect(decision.allowed).toEqual(['eu']);
    expect(decision.audit).toEqual({});
  });

  it('does not apply when its when does not', () => {
    const rule: PolicyRule = {
      id: 'a',
      forbid: { region: 'us' },
      mode: 'audit',
      when: { context: { tenant: 'x' } },
    };
    expect(decide([rule], {}, call({ tenant: 'y' })).audit).toEqual({});
    expect(decide([rule], {}, call({ tenant: 'x' })).audit).toEqual({ a: ['us'] });
  });

  describe('that throws', () => {
    const rule: PolicyRule = { id: 'a', forbid: boom, mode: 'audit' };

    it('is reported as if enforced when closed, and listed as an error', () => {
      const decision = decide([rule], { onError: 'closed' });
      expect(decision.outcome).toBe('allowed');
      expect(decision.audit).toEqual({ a: ['us', 'eu', 'local'] });
      expect(decision.errors).toEqual([{ rule: 'a', name: 'Error', message: 'boom' }]);
    });

    it('is skipped when open, but still listed as an error', () => {
      const decision = decide([rule], { onError: 'open' });
      expect(decision.audit).toEqual({});
      expect(decision.errors).toEqual([{ rule: 'a', name: 'Error', message: 'boom' }]);
    });
  });

  it('gives one decision for every ordering of the rules', () => {
    const rules: PolicyRule[] = [
      { id: 'enforced-forbid', forbid: { name: 'local' } },
      { id: 'audit-forbid', forbid: { region: 'eu' }, mode: 'audit' },
      { id: 'audit-allow', allow: { name: 'us' }, mode: 'audit' },
      { id: 'enforced-allow', allow: { region: ['us', 'eu'] } },
    ];
    const expected = decide(rules);
    expect(expected.audit).not.toEqual({});

    for (const ordering of permutations(rules)) {
      expect(decide(ordering)).toEqual(expected);
    }
  });
});

describe('an audit policy', () => {
  it('turns every rule into an audit rule', () => {
    const decision = decide([{ id: 'f', forbid: { region: 'us' } }], { mode: 'audit' });
    expect(decision.outcome).toBe('allowed');
    expect(decision.removed).toEqual({});
    expect(decision.audit).toEqual({ f: ['us'] });
  });

  it('lets a rule opt back into enforcing', () => {
    const decision = decide(
      [
        { id: 'enforced', forbid: { name: 'us' }, mode: 'enforce' },
        { id: 'audited', forbid: { name: 'eu' } },
      ],
      { mode: 'audit' },
    );
    expect(decision.removed).toEqual({ us: 'enforced' });
    expect(decision.audit).toEqual({ audited: ['eu'] });
  });

  it('lets a rule opt out of an enforcing policy', () => {
    const decision = decide([{ id: 'a', forbid: { name: 'us' }, mode: 'audit' }], {
      mode: 'enforce',
    });
    expect(decision.removed).toEqual({});
    expect(decision.audit).toEqual({ a: ['us'] });
  });

  it('reports a default of deny under the key "default" and denies nothing', () => {
    const decision = decide([], { default: 'deny', mode: 'audit' });
    expect(decision.outcome).toBe('allowed');
    expect(decision.allowed).toEqual(['us', 'eu', 'local']);
    expect(decision.audit).toEqual({ default: ['us', 'eu', 'local'] });
  });

  it('reports only what a default of deny would remove beyond the enforced rules', () => {
    const decision = decide(
      [
        { id: 'enforced', forbid: { name: 'us' }, mode: 'enforce' },
        { id: 'audited', forbid: { name: 'eu' } },
      ],
      { default: 'deny', mode: 'audit' },
    );
    expect(decision.removed).toEqual({ us: 'enforced' });
    expect(decision.audit).toEqual({ audited: ['eu'], default: ['eu', 'local'] });
  });

  it('reports nothing for the default once an enforced allow takes its place', () => {
    const decision = decide([{ id: 'a', allow: { region: 'eu' }, mode: 'enforce' }], {
      default: 'deny',
      mode: 'audit',
    });
    expect(decision.allowed).toEqual(['eu', 'local']);
    expect(decision.audit).toEqual({});
  });

  it('does not touch a default of allow', () => {
    expect(decide([], { mode: 'audit' }).audit).toEqual({});
  });

  it('enforces the default of deny when only a rule is audited', () => {
    const decision = decide([{ id: 'a', forbid: { name: 'us' }, mode: 'audit' }], {
      default: 'deny',
    });
    expect(decision.outcome).toBe('denied');
    expect(decision.removed).toEqual({ us: 'default', eu: 'default', local: 'default' });
  });
});

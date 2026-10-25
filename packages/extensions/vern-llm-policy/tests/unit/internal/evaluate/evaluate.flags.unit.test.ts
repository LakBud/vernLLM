import { describe, expect, it } from 'vitest';

import { call, decide, permutations } from './evaluateHelpers.js';

import type { PolicyRule } from '../../../../src/index.js';

describe('flags', () => {
  it('are empty when no rule sets one', () => {
    const decision = decide([{ id: 'a', forbid: { name: 'us' } }]);
    expect(decision.flags).toEqual({});
    expect(decision.flagCauses).toEqual({});
  });

  it('come from a rule with nothing but set, which removes nothing', () => {
    const decision = decide([{ id: 'a', set: { logContent: false } }]);
    expect(decision.outcome).toBe('allowed');
    expect(decision.flags).toEqual({ logContent: false });
    expect(decision.flagCauses).toEqual({ logContent: 'a' });
  });

  it('record a true flag, with no cause since only false needs one', () => {
    const decision = decide([{ id: 'a', set: { cacheable: true } }]);
    expect(decision.flags).toEqual({ cacheable: true });
    expect(decision.flagCauses).toEqual({});
  });

  it('come from an allow or a forbid too, even one that matches no target', () => {
    const decision = decide([
      { id: 'f', forbid: { region: 'asia' }, set: { duplicateSends: false } },
      { id: 'a', allow: { region: ['us', 'eu'] }, set: { logContent: false } },
    ]);
    expect(decision.flags).toEqual({ duplicateSends: false, logContent: false });
    expect(decision.flagCauses).toEqual({ duplicateSends: 'f', logContent: 'a' });
  });

  it('let false win over true, whichever rule says which', () => {
    const decision = decide([
      { id: 'yes', set: { logContent: true } },
      { id: 'no', set: { logContent: false } },
    ]);
    expect(decision.flags).toEqual({ logContent: false });
    expect(decision.flagCauses).toEqual({ logContent: 'no' });
  });

  it('name the smallest id among the rules that set a flag false', () => {
    const decision = decide([
      { id: 'zeta', set: { logContent: false } },
      { id: 'alpha', set: { logContent: false } },
      { id: 'mid', set: { logContent: true } },
    ]);
    expect(decision.flagCauses).toEqual({ logContent: 'alpha' });
  });

  it('keep separate flags separate', () => {
    const decision = decide([
      { id: 'a', set: { one: false, two: true } },
      { id: 'b', set: { two: true, three: false } },
    ]);
    expect(decision.flags).toEqual({ one: false, two: true, three: false });
    expect(decision.flagCauses).toEqual({ one: 'a', three: 'b' });
  });

  it('are set only while the rule applies', () => {
    const rule: PolicyRule = {
      id: 'a',
      set: { logContent: false },
      when: { context: { plan: 'free' } },
    };
    expect(decide([rule], {}, call({ plan: 'free' })).flags).toEqual({ logContent: false });
    expect(decide([rule], {}, call({ plan: 'pro' })).flags).toEqual({});
  });

  it('are not set by an audit rule', () => {
    const decision = decide([{ id: 'a', set: { logContent: false }, mode: 'audit' }]);
    expect(decision.flags).toEqual({});
    expect(decision.flagCauses).toEqual({});
    expect(decision.audit).toEqual({});
  });

  it('are not set by anything under an audit policy', () => {
    const decision = decide([{ id: 'a', set: { logContent: false } }], { mode: 'audit' });
    expect(decision.flags).toEqual({});
  });

  it('stay set when the same rule removes the targets, a denial included', () => {
    const decision = decide([{ id: 'a', forbid: 'all', set: { logContent: false } }]);
    expect(decision.outcome).toBe('denied');
    expect(decision.flags).toEqual({ logContent: false });
  });

  it('are set by a rule that throws when closed, and not when open', () => {
    const rule: PolicyRule = {
      id: 'a',
      set: { logContent: false },
      when: () => {
        throw new Error('boom');
      },
    };
    expect(decide([rule], { onError: 'closed' }).flags).toEqual({ logContent: false });
    expect(decide([rule], { onError: 'open' }).flags).toEqual({});
  });

  it('are the same for every ordering of the rules', () => {
    const rules: PolicyRule[] = [
      { id: 'c', set: { x: true, y: false } },
      { id: 'a', set: { x: false } },
      { id: 'b', set: { y: false, z: true }, forbid: { name: 'us' } },
      { id: 'audit', set: { z: false }, mode: 'audit' },
    ];
    const expected = decide(rules);
    expect(expected.flags).toEqual({ x: false, y: false, z: true });
    expect(expected.flagCauses).toEqual({ x: 'a', y: 'b' });

    for (const ordering of permutations(rules)) {
      expect(decide(ordering)).toEqual(expected);
    }
  });
});

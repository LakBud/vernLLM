import { describe, expect, it } from 'vitest';

import { failedDecision } from '../../../../src/internal/evaluate/failedDecision.utils.js';
import { compile } from '../../../../src/internal/options/compile.utils.js';
import { all, call, decide, eu, local, permutations, us } from './evaluateHelpers.js';

import type { PolicyRule, TargetFacts } from '../../../../src/index.js';

const boom = (): never => {
  throw new Error('boom');
};

/** Throws for `eu` only, and otherwise matches `us`. */
const throwsOnEu = (facts: TargetFacts): boolean => {
  if (facts.name === 'eu') throw new Error('no eu');
  return facts.name === 'us';
};

describe('a rule that throws', () => {
  describe('a forbid whose when throws', () => {
    const rule: PolicyRule = { id: 'f', forbid: { name: 'us' }, when: boom };

    it('applies when closed, so the pattern still decides who is removed', () => {
      const decision = decide([rule], { onError: 'closed' });
      expect(decision.allowed).toEqual(['eu', 'local']);
      expect(decision.removed).toEqual({ us: 'f' });
      expect(decision.errors).toEqual([{ rule: 'f', name: 'Error', message: 'boom' }]);
    });

    it('does not apply when open', () => {
      const decision = decide([rule], { onError: 'open' });
      expect(decision.outcome).toBe('allowed');
      expect(decision.errors).toEqual([{ rule: 'f', name: 'Error', message: 'boom' }]);
    });

    it('is closed unless said otherwise', () => {
      expect(decide([rule]).removed).toEqual({ us: 'f' });
    });
  });

  describe('a forbid whose pattern throws', () => {
    const rule: PolicyRule = { id: 'f', forbid: throwsOnEu };

    it('removes the target it threw on when closed, and the ones it matched', () => {
      const decision = decide([rule], { onError: 'closed' });
      expect(decision.allowed).toEqual(['local']);
      expect(decision.removed).toEqual({ us: 'f', eu: 'f' });
      expect(decision.errors).toEqual([{ rule: 'f', name: 'Error', message: 'no eu' }]);
    });

    it('leaves the target it threw on alone when open', () => {
      const decision = decide([rule], { onError: 'open' });
      expect(decision.allowed).toEqual(['eu', 'local']);
      expect(decision.removed).toEqual({ us: 'f' });
    });
  });

  describe('an allow whose when throws', () => {
    const rule: PolicyRule = { id: 'a', allow: { name: 'us' }, when: boom };

    it('grants nothing when closed, so the call is denied', () => {
      const decision = decide([rule], { onError: 'closed' });
      expect(decision.outcome).toBe('denied');
      expect(decision.removed).toEqual({ us: 'a', eu: 'a', local: 'a' });
      expect(decision.errors).toEqual([{ rule: 'a', name: 'Error', message: 'boom' }]);
    });

    it('leaves what another allow grants alone when closed', () => {
      const decision = decide([rule, { id: 'ok', allow: { name: 'eu' } }], { onError: 'closed' });
      expect(decision.allowed).toEqual(['eu']);
    });

    it('is skipped when open, so the default applies', () => {
      const decision = decide([rule], { onError: 'open' });
      expect(decision.outcome).toBe('allowed');
      expect(decision.allowed).toEqual(['us', 'eu', 'local']);
      expect(decision.errors).toEqual([{ rule: 'a', name: 'Error', message: 'boom' }]);
    });
  });

  describe('an allow whose pattern throws', () => {
    const rule: PolicyRule = { id: 'a', allow: throwsOnEu };

    it('grants nothing on the target it threw on when closed', () => {
      const decision = decide([rule], { onError: 'closed' });
      expect(decision.allowed).toEqual(['us']);
      expect(decision.removed).toEqual({ eu: 'a', local: 'a' });
    });

    it('is dropped whole when open, so no allow list stays in force', () => {
      const decision = decide([rule], { onError: 'open' });
      expect(decision.allowed).toEqual(['us', 'eu', 'local']);
      expect(decision.outcome).toBe('allowed');
    });
  });

  describe('the errors listed', () => {
    it('name a rule once, however many targets it threw on', () => {
      const decision = decide([{ id: 'f', forbid: boom }]);
      expect(decision.errors).toEqual([{ rule: 'f', name: 'Error', message: 'boom' }]);
    });

    it('keep what a rule said for each target, so the first target to throw never decides', () => {
      const rule: PolicyRule = {
        id: 'f',
        forbid: (facts) => {
          throw new Error(`no ${facts.name}`);
        },
      };

      const lists = permutations([us, eu, local]).map((order) =>
        decide([rule], {}, call(), order).errors.map((error) => error.message),
      );

      for (const list of lists) expect(list).toEqual(['no eu', 'no local', 'no us']);
    });

    it('are listed once when the same failure repeats', () => {
      const decision = decide([{ id: 'f', forbid: boom }]);
      expect(decision.errors).toHaveLength(1);
    });

    it('say what kind of error it was', () => {
      const rule: PolicyRule = {
        id: 'f',
        forbid: () => {
          throw new RangeError('out');
        },
      };
      expect(decide([rule]).errors).toEqual([{ rule: 'f', name: 'RangeError', message: 'out' }]);
    });

    it('are sorted by rule id, whatever order the rules came in', () => {
      const decision = decide([
        { id: 'zeta', forbid: boom },
        { id: 'alpha', forbid: boom },
      ]);
      expect(decision.errors.map((error) => error.rule)).toEqual(['alpha', 'zeta']);
    });

    it('keep a thrown value that is not an error as text', () => {
      const decision = decide([
        {
          id: 'f',
          forbid: () => {
            throw 'plain text';
          },
        },
      ]);
      expect(decision.errors).toEqual([{ rule: 'f', name: 'string', message: 'plain text' }]);
    });

    it('cut a long message short', () => {
      const decision = decide([
        {
          id: 'f',
          forbid: () => {
            throw new Error('x'.repeat(500));
          },
        },
      ]);
      expect(decision.errors[0]!.message).toBe(`${'x'.repeat(200)}...`);
    });

    it('are empty when nothing threw', () => {
      expect(decide([{ id: 'f', forbid: { name: 'us' } }]).errors).toEqual([]);
    });

    it('count a rule that threw in its when and in its pattern once', () => {
      const decision = decide([{ id: 'f', forbid: boom, when: boom }]);
      expect(decision.errors).toHaveLength(1);
    });
  });

  describe('rule order', () => {
    const rules: PolicyRule[] = [
      { id: 'broken-forbid', forbid: throwsOnEu },
      { id: 'broken-when', allow: { region: 'eu' }, when: boom },
      { id: 'fine', forbid: { name: 'local' }, when: { context: { x: 'y' } } },
      { id: 'also-broken', forbid: boom, when: { context: { x: 'y' } } },
    ];

    it.each(['closed', 'open'] as const)(
      'gives one decision for every ordering of the rules, errors included, when %s',
      (onError) => {
        const expected = decide(rules, { onError }, call({ x: 'y' }));
        expect(expected.errors.length).toBeGreaterThan(0);

        for (const ordering of permutations(rules)) {
          expect(decide(ordering, { onError }, call({ x: 'y' }))).toEqual(expected);
        }
      },
    );
  });
});

describe('failedDecision', () => {
  const targetNames = all.map((target) => target.name);

  it('denies the call when closed, with the failure and no rule named', () => {
    const decision = failedDecision(compile({ version: 'v1' }), targetNames, new Error('bug'));
    expect(decision).toEqual({
      version: 'v1',
      outcome: 'denied',
      allowed: [],
      removed: {},
      rules: [],
      audit: {},
      errors: [{ name: 'Error', message: 'bug' }],
      flags: {},
      flagCauses: {},
      exceptions: [],
    });
  });

  it('lets the call through with every target when open', () => {
    const decision = failedDecision(compile({ onError: 'open' }), targetNames, 'bug');
    expect(decision.outcome).toBe('allowed');
    expect(decision.allowed).toEqual(['us', 'eu', 'local']);
    expect(decision.errors).toEqual([{ name: 'string', message: 'bug' }]);
    expect(Object.hasOwn(decision, 'version')).toBe(false);
  });
});

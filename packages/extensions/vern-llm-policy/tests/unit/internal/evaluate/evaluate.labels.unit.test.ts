import { describe, expect, it } from 'vitest';

import { call, decide, permutations } from './evaluateHelpers.js';

import type { PolicyOptions, PolicyRule } from '../../../../src/index.js';

/** Satisfies the requirement for a `labels` option. The labels themselves come in as facts. */
const labeler: Pick<PolicyOptions, 'labels'> = { labels: () => [] };

const piiToZdr: PolicyRule = { id: 'pii-zdr', forbid: { zdr: false }, when: { labels: 'pii' } };
const noContext = undefined;

describe('labels', () => {
  describe('that were found', () => {
    it('make a rule on them apply', () => {
      const decision = decide([piiToZdr], labeler, call(noContext, ['pii']));
      expect(decision.removed).toEqual({ us: 'pii-zdr' });
      expect(decision.errors).toEqual([]);
    });

    it('leave it out when they are not there', () => {
      const decision = decide([piiToZdr], labeler, call(noContext, ['health']));
      expect(decision.outcome).toBe('allowed');
    });

    it('want every label of a list', () => {
      const rule: PolicyRule = { ...piiToZdr, when: { labels: ['pii', 'health'] } };
      expect(decide([rule], labeler, call(noContext, ['pii'])).outcome).toBe('allowed');
      expect(decide([rule], labeler, call(noContext, ['health', 'pii'])).outcome).toBe('narrowed');
    });

    it('combine with other facts of the call', () => {
      const rule: PolicyRule = { ...piiToZdr, when: { labels: 'pii', context: { plan: 'free' } } };
      expect(decide([rule], labeler, call({ plan: 'pro' }, ['pii'])).outcome).toBe('allowed');
      expect(decide([rule], labeler, call({ plan: 'free' }, ['pii'])).outcome).toBe('narrowed');
    });
  });

  describe('that were checked and found nothing', () => {
    it('do not match, so the rule does not apply and nothing is wrong', () => {
      const decision = decide([piiToZdr], labeler, call(noContext, []));
      expect(decision.outcome).toBe('allowed');
      expect(decision.errors).toEqual([]);
      expect(decision.labels).toEqual([]);
    });

    it('make a rule on the absence of a label apply', () => {
      const rule: PolicyRule = { id: 'unchecked', forbid: 'all', when: { not: { labels: 'ok' } } };
      expect(decide([rule], labeler, call(noContext, [])).outcome).toBe('denied');
    });
  });

  describe('that are unknown', () => {
    it('fail a forbid closed, so the rule applies', () => {
      const decision = decide([piiToZdr], { ...labeler, onError: 'closed' }, call());
      expect(decision.removed).toEqual({ us: 'pii-zdr' });
      expect(decision.errors).toEqual([
        { rule: 'pii-zdr', name: 'LabelsUnknownError', message: 'the labels are unknown' },
      ]);
      expect(decision.labels).toBe('unknown');
    });

    it('are the default case, since closed is', () => {
      expect(decide([piiToZdr], labeler, call()).removed).toEqual({ us: 'pii-zdr' });
    });

    it('skip the rule when open', () => {
      const decision = decide([piiToZdr], { ...labeler, onError: 'open' }, call());
      expect(decision.outcome).toBe('allowed');
      expect(decision.labels).toBe('unknown');
      expect(decision.errors).toHaveLength(1);
    });

    it('make an allow grant nothing when closed', () => {
      const rule: PolicyRule = { id: 'pii-eu', allow: { region: 'eu' }, when: { labels: 'pii' } };
      const decision = decide([rule], labeler, call());
      expect(decision.outcome).toBe('denied');
      expect(decision.removed).toEqual({ us: 'pii-eu', eu: 'pii-eu', local: 'pii-eu' });
    });

    it('do not read as "no label" under not', () => {
      const rule: PolicyRule = { id: 'unchecked', forbid: 'all', when: { not: { labels: 'ok' } } };
      expect(decide([rule], { ...labeler, onError: 'open' }, call()).outcome).toBe('allowed');
      expect(decide([rule], { ...labeler, onError: 'closed' }, call()).outcome).toBe('denied');
    });

    it('do not matter to a rule that does not read them', () => {
      const decision = decide([{ id: 'a', forbid: { name: 'us' } }], labeler, call());
      expect(decision.errors).toEqual([]);
    });

    it('leave an exception that reads them uncovering', () => {
      const rule: PolicyRule = {
        id: 'a',
        forbid: { name: 'us' },
        except: [{ when: { labels: 'ok' }, until: '2026-12-01', reason: 'r' }],
      };
      const decision = decide([rule], labeler, call());
      expect(decision.removed).toEqual({ us: 'a' });
      expect(decision.exceptions).toEqual([]);
    });
  });

  describe('in the decision', () => {
    const rules = [piiToZdr];

    it('are sorted and listed once, whatever order the labeler gave', () => {
      const decision = decide(rules, labeler, call(noContext, ['pii', 'health', 'pii', 'a']));
      expect(decision.labels).toEqual(['a', 'health', 'pii']);
    });

    it('are absent when the policy has no labels option', () => {
      expect(Object.hasOwn(decide([{ id: 'a', forbid: { name: 'us' } }]), 'labels')).toBe(false);
    });

    it('are absent when no rule reads them', () => {
      const decision = decide([{ id: 'a', forbid: { name: 'us' } }], labeler, call());
      expect(Object.hasOwn(decision, 'labels')).toBe(false);
    });
  });

  it('give one decision for every ordering of the rules', () => {
    const rules: PolicyRule[] = [
      piiToZdr,
      { id: 'health-eu', forbid: { region: 'us' }, when: { labels: 'health' } },
      { id: 'b-flag', set: { logContent: false }, when: { labels: ['pii', 'health'] } },
      { id: 'plain', forbid: { name: 'local' } },
    ];
    for (const facts of [call(), call(noContext, []), call(noContext, ['pii', 'health'])]) {
      const expected = decide(rules, labeler, facts);
      for (const ordering of permutations(rules)) {
        expect(decide(ordering, labeler, facts)).toEqual(expected);
      }
    }
  });
});

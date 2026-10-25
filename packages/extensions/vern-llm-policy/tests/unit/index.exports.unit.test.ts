import { describe, expect, it } from 'vitest';

import * as pkg from '../../src/index.js';

describe('the public surface', () => {
  it('exports the middleware and its ref, and nothing else at runtime', () => {
    expect(Object.keys(pkg).sort()).toEqual([
      'POLICY_CROSS_JOIN_EVENT',
      'POLICY_DECISION_EVENT',
      'policyFlags',
      'policyMiddleware',
      'policyMiddlewareRef',
    ]);
  });

  it('names the events', () => {
    expect(pkg.POLICY_DECISION_EVENT).toBe('policy.decision');
    expect(pkg.POLICY_CROSS_JOIN_EVENT).toBe('policy.cross_join');
  });

  it('builds a middleware that can be asked and changed', () => {
    const policy = pkg.policyMiddleware({});
    expect(policy.evaluate).toBeTypeOf('function');
    expect(policy.update).toBeTypeOf('function');
  });

  it('builds a middleware that sits in front of usage and the router', () => {
    const policy = pkg.policyMiddleware({});
    expect(policy.name).toBe('policy');
    expect(policy.ref).toBe(pkg.policyMiddlewareRef);
    expect(policy.position).toBe(-100);
    expect(policy.wrap).toBeTypeOf('function');
  });

  it('builds with no options at all, allowing everything', () => {
    expect(() => pkg.policyMiddleware()).not.toThrow();
  });

  it('refuses options that cannot work, before any call', () => {
    expect(() => pkg.policyMiddleware({ rules: [{ id: 'a' }] })).toThrow(
      'policyMiddleware: rule "a" must have allow, forbid or set',
    );
  });
});

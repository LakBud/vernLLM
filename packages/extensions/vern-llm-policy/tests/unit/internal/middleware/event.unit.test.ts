import { describe, expect, it } from 'vitest';

import { crossJoinEvent, decisionEvent } from '../../../../src/internal/middleware/event.utils.js';

import type { Decision } from '../../../../src/index.js';

const decision = (overrides: Partial<Decision> = {}): Decision => ({
  outcome: 'allowed',
  allowed: ['a'],
  removed: {},
  rules: [],
  audit: {},
  errors: [],
  flags: {},
  flagCauses: {},
  exceptions: [],
  ...overrides,
});

describe('decisionEvent', () => {
  it('leaves the version and labels out when the decision has none', () => {
    expect(decisionEvent(decision())).toEqual({
      v: 1,
      outcome: 'allowed',
      removed: {},
      audit: {},
      errors: [],
      flags: {},
      exceptions: [],
    });
  });

  it('carries the version, the labels and the flag causes', () => {
    const event = decisionEvent(
      decision({ version: 'v1', labels: ['pii'], flags: { x: false }, flagCauses: { x: 'r' } }),
    );
    expect(event).toMatchObject({ version: 'v1', labels: ['pii'], flags: { x: 'r' } });
  });

  it('lists each failure once, as a rule and a kind, without what it said', () => {
    const event = decisionEvent(
      decision({
        errors: [
          { name: 'TypeError', message: 'secret one' },
          { rule: 'a', name: 'Error', message: 'secret two' },
          { rule: 'a', name: 'Error', message: 'another secret' },
          { rule: 'b', name: 'Error', message: 'secret three' },
        ],
      }),
    );
    expect(event.errors).toEqual([
      { name: 'TypeError' },
      { rule: 'a', name: 'Error' },
      { rule: 'b', name: 'Error' },
    ]);
    expect(JSON.stringify(event)).not.toContain('secret');
  });
});

describe('crossJoinEvent', () => {
  it('names the target and the rule, and the version when there is one', () => {
    expect(crossJoinEvent(undefined, 't', 'r')).toEqual({ v: 1, target: 't', rule: 'r' });
    expect(crossJoinEvent('v1', 't', 'r')).toEqual({ v: 1, version: 'v1', target: 't', rule: 'r' });
  });
});

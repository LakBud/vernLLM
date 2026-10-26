import { describe, expect, it } from 'vitest';

import { hedgeDimension, promptSizeDimension } from '../../src/index.js';

describe('promptSizeDimension', () => {
  it.each([
    [10, 'xs'],
    [1_000, 's'],
    [5_000, 'm'],
    [20_000, 'l'],
    [100_000, 'xl'],
  ])('puts %i prompt tokens in %s', (promptTokens, bucket) => {
    expect(promptSizeDimension({ usage: { promptTokens } })).toBe(bucket);
  });

  it('yields nothing for a record with no usable prompt tokens', () => {
    expect(promptSizeDimension({})).toBeUndefined();
    expect(promptSizeDimension({ usage: {} })).toBeUndefined();
    expect(promptSizeDimension({ usage: { promptTokens: Number.NaN } })).toBeUndefined();
    expect(promptSizeDimension({ usage: { promptTokens: -1 } })).toBeUndefined();
  });
});

describe('hedgeDimension', () => {
  const record = (...events: unknown[]) => ({ custom: { 'hedge.decision': events } });

  it('reads the outcome of the last decision', () => {
    expect(hedgeDimension(record({ outcome: 'budget' }, { outcome: 'won' }))).toBe('won');
  });

  it.each(['won', 'lost', 'not_needed', 'budget', 'paused', 'cached', 'no_data', 'deadline'])(
    'passes the %s outcome through',
    (outcome) => {
      expect(hedgeDimension(record({ outcome }))).toBe(outcome);
    },
  );

  it('yields nothing without a decision', () => {
    expect(hedgeDimension({})).toBeUndefined();
    expect(hedgeDimension({ custom: {} })).toBeUndefined();
    expect(hedgeDimension(record())).toBeUndefined();
  });

  it('yields nothing for an event it does not recognize', () => {
    expect(hedgeDimension(record('won'))).toBeUndefined();
    expect(hedgeDimension(record(null))).toBeUndefined();
    expect(hedgeDimension(record({ outcome: 'sideways' }))).toBeUndefined();
    expect(hedgeDimension(record({}))).toBeUndefined();
  });

  it('ignores other events', () => {
    expect(hedgeDimension({ custom: { 'router.decision': [{ outcome: 'won' }] } })).toBeUndefined();
  });
});

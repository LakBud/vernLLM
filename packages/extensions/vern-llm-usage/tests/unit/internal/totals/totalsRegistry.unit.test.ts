import { describe, expect, it } from 'vitest';

import {
  TotalsRegistry,
  type CallOutcome,
} from '../../../../src/internal/totals/totalsRegistry.js';

const noTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
const at = (iso: string) => Date.parse(iso);

function outcome(overrides: Partial<CallOutcome> = {}, nanoUsd = 1_000_000): CallOutcome {
  const tokens = { ...noTokens, input: 10, output: 5 };
  return {
    snapshot: {
      nanoUsd,
      wastedNanoUsd: 0,
      unkeptNanoUsd: 0,
      tokens,
      tableCharges: 1,
      reportedCharges: 0,
      unpricedCharges: 0,
      provider: 'primary',
      model: 'm',
      parts: [
        {
          provider: 'primary',
          model: 'm',
          nanoUsd,
          wastedNanoUsd: 0,
          unkeptNanoUsd: 0,
          tokens,
          tableCharges: 1,
          reportedCharges: 0,
          unpricedCharges: 0,
        },
      ],
    },
    fallbackProvider: 'primary',
    fallbackModel: 'm',
    attribution: {},
    cache: undefined,
    unknownSpend: false,
    ...overrides,
  };
}

const registry = (maxSeries = 100, warnings: string[] = [], timeZone = 'UTC') =>
  new TotalsRegistry(maxSeries, timeZone, (message) => warnings.push(message));

describe('TotalsRegistry', () => {
  it('reads zeros before anything was added', () => {
    expect(registry().read({}, {}, Date.now())).toEqual({
      estimatedCostUsd: 0,
      wastedUsd: 0,
      unkeptUsd: 0,
      estimatedSavedUsd: 0,
      calls: 0,
      bySource: { reported: 0, table: 0, unpriced: 0 },
      tokens: noTokens,
      cacheHits: 0,
      joins: 0,
      unknownSpendCalls: 0,
    });
  });

  it('sums money exactly in nano dollars and reports dollars', () => {
    const r = registry();
    const now = at('2026-10-20T12:00:00Z');
    for (let i = 0; i < 3; i++) r.add(outcome({}, 100_000_000), now);

    expect(r.read({}, {}, now).estimatedCostUsd).toBe(0.3);
  });

  it('counts hits, joins and unknown spend, and the model of a call never charged', () => {
    const r = registry();
    const now = at('2026-10-20T12:00:00Z');
    const none = {
      ...outcome().snapshot,
      provider: undefined,
      model: undefined,
      tableCharges: 0,
      parts: [],
    };

    r.add(outcome({ snapshot: none, cache: 'hit', fallbackModel: 'x' }), now);
    r.add(outcome({ snapshot: none, cache: 'join', fallbackModel: 'x' }), now);
    r.add(outcome({ unknownSpend: true }), now);

    expect(r.read({}, { model: 'x' }, now)).toMatchObject({ calls: 2, cacheHits: 1, joins: 1 });
    expect(r.read({}, {}, now).unknownSpendCalls).toBe(1);
  });

  it('sums what hits and joins spared, and only for calls that carry an estimate', () => {
    const r = registry();
    const now = at('2026-10-20T12:00:00Z');

    r.add(outcome({ cache: 'hit', savedNanoUsd: 250_000_000 }, 0), now);
    r.add(outcome({ cache: 'join', savedNanoUsd: 750_000_000 }, 0), now);
    r.add(outcome({ cache: 'hit' }, 0), now);

    expect(r.read({}, {}, now)).toMatchObject({ estimatedSavedUsd: 1, cacheHits: 2, joins: 1 });
  });

  it('splits a call over the targets that produced its charges, and counts it once', () => {
    const r = registry();
    const now = at('2026-10-20T12:00:00Z');
    const part = (provider: string, model: string, nanoUsd: number, wastedNanoUsd: number) => ({
      provider,
      model,
      nanoUsd,
      wastedNanoUsd,
      unkeptNanoUsd: 0,
      tokens: { ...noTokens, input: 10 },
      tableCharges: 1,
      reportedCharges: 0,
      unpricedCharges: 0,
    });
    const primary = part('primary', 'a', 3_000_000, 3_000_000);
    const backup = part('backup', 'b', 2_000_000, 0);

    r.add(
      outcome({
        snapshot: {
          ...outcome().snapshot,
          nanoUsd: 5_000_000,
          wastedNanoUsd: 3_000_000,
          tableCharges: 2,
          provider: 'backup',
          model: 'b',
          parts: [primary, backup],
        },
      }),
      now,
    );

    expect(r.read({}, { provider: 'primary' }, now)).toMatchObject({
      estimatedCostUsd: 0.003,
      wastedUsd: 0.003,
      calls: 0,
    });
    expect(r.read({}, { provider: 'backup', model: 'b' }, now)).toMatchObject({
      estimatedCostUsd: 0.002,
      wastedUsd: 0,
      calls: 1,
    });
    expect(r.read({}, {}, now)).toMatchObject({ estimatedCostUsd: 0.005, calls: 1 });
  });

  it('puts a charge that names no target on the primary', () => {
    const r = registry();
    const now = at('2026-10-20T12:00:00Z');
    const base = outcome();
    const [named] = base.snapshot.parts;

    r.add(
      {
        ...base,
        fallbackProvider: 'primary',
        fallbackModel: 'm',
        snapshot: {
          ...base.snapshot,
          provider: undefined,
          model: undefined,
          parts: [{ ...named!, provider: undefined, model: undefined }],
        },
      },
      now,
    );

    expect(r.read({}, { provider: 'primary', model: 'm' }, now)).toMatchObject({
      estimatedCostUsd: 0.001,
      calls: 1,
    });
  });

  it('counts a day by the clock of its time zone', () => {
    const r = registry(100, [], 'America/New_York');

    r.add(outcome({}, 100_000_000), at('2026-10-21T03:30:00Z'));

    // Still 20 Oct in New York, though already 21 Oct in UTC.
    expect(r.read({}, {}, at('2026-10-21T03:59:00Z')).calls).toBe(1);
    expect(r.read({}, {}, at('2026-10-21T04:01:00Z')).calls).toBe(0);
  });

  it('keeps the current and previous window of each kind and drops older ones', () => {
    const r = registry();
    r.add(outcome(), at('2026-10-18T12:00:00Z'));
    r.add(outcome(), at('2026-10-19T12:00:00Z'));
    r.add(outcome(), at('2026-10-20T12:00:00Z'));

    expect(r.read({}, {}, at('2026-10-20T12:00:00Z')).calls).toBe(1);
    expect(r.read({}, {}, at('2026-10-19T12:00:00Z')).calls).toBe(1);
    expect(r.read({}, {}, at('2026-10-18T12:00:00Z')).calls).toBe(0);
    expect(r.read({}, { window: 'month' }, at('2026-10-20T12:00:00Z')).calls).toBe(3);
  });

  it('sends series past the cap to __other__ with one warning, and reuses existing series', () => {
    const warnings: string[] = [];
    const r = registry(2, warnings);
    const now = at('2026-10-20T12:00:00Z');

    for (const tenant of ['a', 'b', 'c', 'd', 'a']) {
      r.add(outcome({ attribution: { tenantId: tenant } }), now);
    }

    expect(r.read({}, {}, now).calls).toBe(5);
    expect(r.read({ tenantId: 'a' }, {}, now).calls).toBe(2);
    expect(r.read({}, { provider: '__other__' }, now).calls).toBe(2);
    expect(warnings).toHaveLength(1);
  });
});

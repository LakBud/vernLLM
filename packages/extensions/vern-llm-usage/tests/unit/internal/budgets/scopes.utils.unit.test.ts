import { describe, expect, it } from 'vitest';

import { scopesFor } from '../../../../src/internal/budgets/scopes.utils.js';

import type { ResolvedBudget } from '../../../../src/types/index.js';

const now = Date.parse('2026-10-20T12:00:00Z');
const tenant: ResolvedBudget = {
  key: 'tenantId',
  equals: undefined,
  unit: 'usd',
  limit: 5,
  per: 'day',
  mode: 'hard',
};

describe('scopesFor', () => {
  it('makes one scope per matching budget, labelled with the value and window', () => {
    const [scope] = scopesFor([tenant], { tenantId: 'acme' }, now);

    expect(scope).toMatchObject({ label: 'tenantId=acme per day', unit: 'usd', limit: 5 });
    expect(scope!.resetsAtMs).toBe(Date.parse('2026-10-21T00:00:00Z'));
  });

  it('returns nothing without context, or when the key is missing or not a scalar', () => {
    expect(scopesFor([tenant], undefined, now)).toEqual([]);
    expect(scopesFor([tenant], {}, now)).toEqual([]);
    expect(scopesFor([tenant], { tenantId: null }, now)).toEqual([]);
    expect(scopesFor([tenant], { tenantId: { id: 1 } }, now)).toEqual([]);
  });

  it('honours equals with a strict comparison', () => {
    const only = { ...tenant, equals: 1 };

    expect(scopesFor([only], { tenantId: 1 }, now)).toHaveLength(1);
    expect(scopesFor([only], { tenantId: '1' }, now)).toEqual([]);
  });

  it('keeps scopes apart by budget, value and window', () => {
    const other: ResolvedBudget = { ...tenant, unit: 'tokens', limit: 9 };
    const keys = new Set(
      [
        scopesFor([tenant, other], { tenantId: 'a' }, now).map((s) => s.key),
        scopesFor([tenant], { tenantId: 'b' }, now).map((s) => s.key),
        scopesFor([tenant], { tenantId: 'a' }, now + 86_400_000).map((s) => s.key),
      ].flat(),
    );

    expect(keys.size).toBe(4);
  });

  it('keeps a hard scope key byte for byte, and suffixes a soft one so the two stay apart', () => {
    const [hard] = scopesFor([tenant], { tenantId: 'a' }, now);
    const [soft] = scopesFor([{ ...tenant, mode: 'soft' }], { tenantId: 'a' }, now);

    expect(hard!.key).toBe('["tenantId",null,"usd","a","day:2026-10-20"]');
    expect(soft!.key).toBe('["tenantId",null,"usd","a","day:2026-10-20","soft"]');
    expect([hard!.mode, soft!.mode]).toEqual(['hard', 'soft']);
  });

  it('keeps a scope when budgets are reordered or a limit changes', () => {
    const tokens: ResolvedBudget = { ...tenant, unit: 'tokens', limit: 9 };
    const before = scopesFor([tenant, tokens], { tenantId: 'a' }, now).map((s) => s.key);
    const after = scopesFor(
      [
        { ...tokens, limit: 99 },
        { ...tenant, limit: 50 },
      ],
      { tenantId: 'a' },
      now,
    )
      .map((s) => s.key)
      .reverse();

    expect(after).toEqual(before);
  });

  it('keeps a budget for every value apart from one for a single value', () => {
    const acme: ResolvedBudget = { ...tenant, equals: 'acme' };
    const [all, one] = scopesFor([tenant, acme], { tenantId: 'acme' }, now);

    expect(all!.key).not.toBe(one!.key);
  });

  it('cannot confuse two values that only look alike when joined', () => {
    const a = scopesFor([tenant], { tenantId: 'x","day:2026' }, now)[0]!.key;
    const b = scopesFor([tenant], { tenantId: 'x' }, now)[0]!.key;

    expect(a).not.toBe(b);
  });
});

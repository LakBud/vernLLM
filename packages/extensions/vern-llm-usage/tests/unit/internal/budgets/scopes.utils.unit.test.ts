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
    const other = { ...tenant, limit: 9 };
    const keys = new Set(
      [
        scopesFor([tenant, other], { tenantId: 'a' }, now).map((s) => s.key),
        scopesFor([tenant], { tenantId: 'b' }, now).map((s) => s.key),
        scopesFor([tenant], { tenantId: 'a' }, now + 86_400_000).map((s) => s.key),
      ].flat(),
    );

    expect(keys.size).toBe(4);
  });

  it('cannot confuse two values that only look alike when joined', () => {
    const a = scopesFor([tenant], { tenantId: 'x","day:2026' }, now)[0]!.key;
    const b = scopesFor([tenant], { tenantId: 'x' }, now)[0]!.key;

    expect(a).not.toBe(b);
  });
});

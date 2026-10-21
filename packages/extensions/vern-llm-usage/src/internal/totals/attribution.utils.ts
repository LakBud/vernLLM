import { isScalar } from '../budgets/scopes.utils.js';

/** The attributed context values of a call, for the totals. */
export function attributionOf(
  keys: readonly string[],
  context: Readonly<Record<string, unknown>> | undefined,
): Record<string, string | number | boolean> {
  const values: Record<string, string | number | boolean> = {};
  for (const key of keys) {
    const value = context?.[key];
    if (isScalar(value)) values[key] = value;
  }
  return values;
}

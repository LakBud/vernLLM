import { describe, errorName } from '../errors.utils.js';

import type { DecisionError } from '../../types/decision.js';

/** Collects rule errors, one entry per distinct failure, so target order never shows. */
export function createErrorLog(): {
  errors: DecisionError[];
  note: (rule: string, error: unknown) => void;
} {
  const errors: DecisionError[] = [];
  const noted = new Set<string>();

  return {
    errors,
    note: (rule, error) => {
      const entry = { rule, name: errorName(error), message: describe(error) };
      const key = [rule, entry.name, entry.message].join('\u0000');
      if (noted.has(key)) return;
      noted.add(key);
      errors.push(entry);
    },
  };
}

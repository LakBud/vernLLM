import type { DecisionError, DecisionException } from '../../types/decision.js';

export function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function byError(a: DecisionError, b: DecisionError): number {
  return (
    compare(a.rule ?? '', b.rule ?? '') || compare(a.name, b.name) || compare(a.message, b.message)
  );
}

export function byException(a: DecisionException, b: DecisionException): number {
  return compare(a.rule, b.rule) || compare(a.until, b.until) || compare(a.reason, b.reason);
}

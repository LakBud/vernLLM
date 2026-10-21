import type { DimensionExtractor } from '../../types/index.js';

/** A dimension read from `field` of the last kept custom event called `name`. */
export function fromEvent(name: string, field: string): DimensionExtractor {
  return (record) => {
    const events = record.custom?.[name];
    const last = events?.[events.length - 1];
    if (typeof last !== 'object' || last === null || Array.isArray(last)) return undefined;

    const value = last[field];
    return typeof value === 'string' ? value : undefined;
  };
}

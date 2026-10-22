/** What one call's attempts did on one target, for the quality failure rate. */
export interface AttemptTally {
  provider: string;
  model: string;
  /** Attempts that got a response, usable or not. An outage is neither good nor bad quality. */
  responded: number;
  /** Responded attempts whose answer was rejected as unusable. */
  qualityFailures: number;
}

/**
 * Tallies ride beside the record, not in it, so the frozen record sinks receive stays as it is.
 * Keyed by the record object, so they are gone when it is.
 */
const tallies = new WeakMap<object, readonly AttemptTally[]>();

export function attachTallies(record: object, list: readonly AttemptTally[]): void {
  if (list.length > 0) tallies.set(record, list);
}

export function talliesOf(record: object): readonly AttemptTally[] | undefined {
  return tallies.get(record);
}

import type { LoggerOption } from '../../types/index.js';

/** What every hosted detector accepts besides its provider's own options. */
export interface HostedOptions {
  /** Requests in flight at once for one detector. An integer of at least 1, default 4. */
  concurrency?: number;
  /** Findings remembered per source and text. `false` turns it off. Default `{ max: 10_000 }`. */
  cache?: false | { max?: number };
  /** Longer texts are split in chunks of this size, at least 1000. */
  chunkChars?: number;
  /** How much of the previous chunk the next one starts with. Below `chunkChars`. */
  overlapChars?: number;
  /** Where the detector reports a configuration warning. Default: a console logger. */
  logger?: LoggerOption;
}

export interface HostedSettings {
  concurrency: number;
  cache: false | { max: number };
  chunkChars: number;
  overlapChars: number;
}

const isInteger = (value: unknown, min: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min;

/** Checks the options every hosted detector shares, and fills in what was left out. */
export function hostedSettings(
  name: string,
  options: HostedOptions,
  defaults: { chunkChars: number; overlapChars: number },
): HostedSettings {
  const { concurrency = 4, chunkChars = defaults.chunkChars } = options;
  const { overlapChars = defaults.overlapChars, cache = {} } = options;

  if (!isInteger(concurrency, 1)) {
    throw new TypeError(`${name}: concurrency must be an integer of at least 1`);
  }
  if (!isInteger(chunkChars, 1000)) {
    throw new TypeError(`${name}: chunkChars must be an integer of at least 1000`);
  }
  if (!isInteger(overlapChars, 0) || overlapChars >= chunkChars) {
    throw new TypeError(
      `${name}: overlapChars must be an integer of at least 0 and below chunkChars`,
    );
  }
  if (cache !== false && (typeof cache !== 'object' || cache === null)) {
    throw new TypeError(`${name}: cache must be false or an object with max`);
  }

  const max = cache === false ? 0 : (cache.max ?? 10_000);
  if (cache !== false && !isInteger(max, 1)) {
    throw new TypeError(`${name}: cache.max must be an integer of at least 1`);
  }

  return { concurrency, chunkChars, overlapChars, cache: cache === false ? false : { max } };
}

/**
 * Checks an `onUsage` option and returns a function that calls it and never throws: reporting
 * cost must not fail a check.
 */
export function usageReporter<T>(
  name: string,
  onUsage: ((info: T) => void) | undefined,
): (info: T) => void {
  if (onUsage !== undefined && typeof onUsage !== 'function') {
    throw new TypeError(`${name}: onUsage must be a function`);
  }
  return (info) => {
    try {
      onUsage?.(info);
    } catch {
      // A throwing callback must not break a check.
    }
  };
}

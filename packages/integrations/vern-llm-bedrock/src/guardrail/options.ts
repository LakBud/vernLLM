import type { BedrockGuardrailOptions, GuardrailClient, GuardrailUsageInfo } from './types.js';

/** The options of one detector, checked and with every default filled in. */
export interface GuardrailSettings {
  client: GuardrailClient;
  guardrailIdentifier: string;
  guardrailVersion: string;
  concurrency: number;
  chunkChars: number;
  overlapChars: number;
  cache: false | { max: number };
  /** Calls `onUsage` and never throws: reporting cost must not fail a check. */
  report: (info: GuardrailUsageInfo) => void;
}

const isInteger = (value: unknown, min: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min;

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** Checks the options and fills in what was left out. Errors read `<name>: <field> must be ...`. */
export function resolveOptions(name: string, options: BedrockGuardrailOptions): GuardrailSettings {
  const { client, guardrailIdentifier, guardrailVersion, onUsage } = options;
  const { concurrency = 4, chunkChars = 12_000, overlapChars = 200, cache = {} } = options;

  if (typeof client?.send !== 'function') {
    throw new TypeError(`${name}: client.send must be a function`);
  }
  if (!isText(guardrailIdentifier)) {
    throw new TypeError(`${name}: guardrailIdentifier must be a non empty string`);
  }
  if (!isText(guardrailVersion)) {
    throw new TypeError(`${name}: guardrailVersion must be a non empty string`);
  }
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
  if (onUsage !== undefined && typeof onUsage !== 'function') {
    throw new TypeError(`${name}: onUsage must be a function`);
  }

  return {
    client,
    guardrailIdentifier,
    guardrailVersion,
    concurrency,
    chunkChars,
    overlapChars,
    cache: cache === false ? false : { max },
    report: (info) => {
      try {
        onUsage?.(info);
      } catch {
        // A throwing callback must not break a check.
      }
    },
  };
}

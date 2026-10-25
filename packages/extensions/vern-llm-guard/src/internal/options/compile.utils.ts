import { compileCheck } from './compileCheck.utils.js';
import { compileSpotlight } from './compileSpotlight.utils.js';
import { compileStream } from './compileStream.utils.js';
import { invalid } from './invalid.utils.js';
import { DEFAULT_MEMO_MAX, ERROR_MODES, MIN_KEY_BYTES, isRecord } from './settings.utils.js';
import { choice, nonEmptyString, optionalFunction } from './validate.utils.js';

import type { GuardOptions } from '../../types/index.js';
import type { CompiledChecks } from '../../types/resolvedConfig.js';

/** The memo's size: `0` when it is off. */
function compileMemo(memo: GuardOptions['memo']): number {
  if (memo === undefined) return DEFAULT_MEMO_MAX;
  if (memo === false) return 0;
  const max = isRecord(memo) ? (memo.max ?? DEFAULT_MEMO_MAX) : undefined;
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 1) {
    invalid('memo must be false, or an object with a max that is a positive integer');
  }
  return max;
}

/** The key as bytes, or `undefined` when it is neither text nor bytes. */
function keyBytes(key: unknown): Buffer | undefined {
  if (key instanceof Uint8Array) return Buffer.from(key);
  if (typeof key === 'string') return Buffer.from(key, 'utf8');
  return undefined;
}

/** The bytes of the key option, when there is one. */
function compileKey(key: GuardOptions['key']): Buffer | undefined {
  if (key === undefined) return undefined;
  const bytes = keyBytes(key);
  if (bytes === undefined || bytes.length < MIN_KEY_BYTES) {
    invalid(`key must be a string or bytes of at least ${MIN_KEY_BYTES} bytes`);
  }
  return bytes;
}

/**
 * Validates the options and fills in defaults. Everything it returns is frozen, so a call can hold
 * it for its whole life while an update swaps in another.
 */
export function compile(options: GuardOptions): CompiledChecks {
  if (!isRecord(options)) invalid('options must be an object');

  const version = nonEmptyString(options.version, 'version');
  if (!Array.isArray(options.checks)) invalid('checks must be an array');

  const failClosed = choice(options.onError, 'closed', ERROR_MODES, 'onError') === 'closed';
  const memoMax = compileMemo(options.memo);
  const key = compileKey(options.key);
  optionalFunction(options.mask, 'mask');
  const mask = options.mask ?? ((label: string) => `[${label.toUpperCase()}]`);

  const stream = compileStream(options);
  const spotlight = compileSpotlight(options);

  const seen = new Set<string>();
  const checks = options.checks.map((raw, index) => {
    const compiled = compileCheck(raw, index, failClosed);
    if (seen.has(compiled.id)) invalid(`checks[${index}].id "${compiled.id}" is used twice`);
    seen.add(compiled.id);
    return compiled;
  });

  const parallel = checks.filter((check) => check.parallel);

  return Object.freeze({
    version,
    checks: Object.freeze(checks),
    memoMax,
    failClosed,
    mask,
    key,
    serial:
      parallel.length === 0
        ? undefined
        : new Set(checks.filter((check) => !check.parallel).map((check) => check.id)),
    parallel: Object.freeze(parallel),
    spotlight,
    stream,
  });
}

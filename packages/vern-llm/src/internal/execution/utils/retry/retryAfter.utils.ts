/**
 * Default cap (ms) for both exponential backoff and honored Retry-After
 * values, so a misbehaving/adversarial Retry-After can't stall a caller
 * indefinitely
 */
export const DEFAULT_MAX_DELAY_MS = 10_000;

type HeaderKind = 'ms' | 'seconds' | 'date';

/**
 * Headers checked in order. The millisecond forms come first for finer timing; Retry-After is read
 * as seconds and as an HTTP date.
 */
const RETRY_AFTER_CANDIDATES: { name: string; kind: HeaderKind }[] = [
  { name: 'Retry-After-Ms', kind: 'ms' },
  { name: 'X-Retry-After-Ms', kind: 'ms' },
  { name: 'Retry-After', kind: 'seconds' },
  { name: 'Retry-After', kind: 'date' },
];

/** Reads a header from a `Headers` object or a plain object, case insensitively. */
function readHeader(headers: object, name: string): string | undefined {
  const getter = headers as { get?: (n: string) => string | null };

  if (typeof getter.get === 'function') {
    return getter.get(name) ?? undefined;
  }

  const match = Object.entries(headers as Record<string, unknown>).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  )?.[1];

  return typeof match === 'string' ? match : undefined;
}

/**
 * A negative value (a malformed delta or a past date) gave no usable timing, so it counts as absent
 * rather than a 0ms retry.
 */
function clampOrUndefined(rawMs: number, maxDelayMs: number): number | undefined {
  return rawMs < 0 ? undefined : Math.min(rawMs, maxDelayMs);
}

/**
 * Provider retry timing in ms from an unknown error: known millisecond headers first, then
 * Retry-After as seconds or an HTTP date. Reads `.headers`, then `.response.headers`. Capped at
 * `maxDelayMs`; `undefined` when nothing usable is present.
 */
export function extractRetryAfterMs(
  err: unknown,
  maxDelayMs: number = DEFAULT_MAX_DELAY_MS,
): number | undefined {
  if (!err || typeof err !== 'object') return undefined;

  const error = err as { headers?: unknown; response?: { headers?: unknown } };
  const headers = error.headers ?? error.response?.headers;

  if (!headers || typeof headers !== 'object') return undefined;

  for (const { name, kind } of RETRY_AFTER_CANDIDATES) {
    const raw = readHeader(headers, name)?.trim();
    if (!raw) continue;

    if (kind === 'ms' && /^\d+$/.test(raw)) {
      return clampOrUndefined(Number(raw), maxDelayMs);
    }

    if (kind === 'seconds' && /^\d+(\.\d+)?$/.test(raw)) {
      return clampOrUndefined(Number(raw) * 1000, maxDelayMs);
    }

    if (kind === 'date') {
      const dateMs = Date.parse(raw);
      if (!Number.isNaN(dateMs)) return clampOrUndefined(dateMs - Date.now(), maxDelayMs);
    }
  }

  return undefined;
}

/**
 * Returns the cap unchanged or throws. `0` (retry at once) and `Infinity` (no cap) are valid;
 * negative or NaN throws at construction.
 */
export function validateMaxRetryAfterMs(maxRetryAfterMs: number, providerName: string): number {
  if (typeof maxRetryAfterMs !== 'number' || Number.isNaN(maxRetryAfterMs) || maxRetryAfterMs < 0) {
    throw new RangeError(
      `${providerName}: maxRetryAfterMs must be 0 or more (Infinity for no cap), got ${String(maxRetryAfterMs)}`,
    );
  }

  return maxRetryAfterMs;
}

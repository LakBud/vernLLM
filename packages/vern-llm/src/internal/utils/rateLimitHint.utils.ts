/** A normalized read of a provider's rate limit headers. */
export interface ProviderRateLimitHint {
  remainingRequests?: number;
  limitRequests?: number;
  resetAfterMs?: number;
}

/** The minimal shape needed to read a header by name, satisfied by `Headers` and `ResponseLike['headers']`. */
export interface HeaderReader {
  get(name: string): string | null;
}

/** Parses a Go-style duration (`"1s"`, `"6m0s"`) into ms, OpenAI's `x-ratelimit-reset-*` format. Undefined if unrecognized. */
function parseGoDuration(value: string): number | undefined {
  const match =
    /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+)ms)?$/.exec(
      value.trim(),
    );

  if (!match || match[0] === '') return undefined;

  const [, hours, minutes, seconds, millis] = match;
  const ms =
    (hours ? parseFloat(hours) * 3_600_000 : 0) +
    (minutes ? parseFloat(minutes) * 60_000 : 0) +
    (seconds ? parseFloat(seconds) * 1_000 : 0) +
    (millis ? parseInt(millis, 10) : 0);

  return Number.isFinite(ms) ? ms : undefined;
}

function parseIntHeader(headers: HeaderReader, name: string): number | undefined {
  const raw = headers.get(name);

  if (raw === null) return undefined;

  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** OpenAI's (and every OpenAI-compatible provider's) header set: `x-ratelimit-{limit,remaining,reset}-requests`. */
export function parseOpenAIRateLimitHeaders(headers: HeaderReader): ProviderRateLimitHint {
  const resetRaw = headers.get('x-ratelimit-reset-requests');

  return {
    limitRequests: parseIntHeader(headers, 'x-ratelimit-limit-requests'),
    remainingRequests: parseIntHeader(headers, 'x-ratelimit-remaining-requests'),
    resetAfterMs: resetRaw !== null ? parseGoDuration(resetRaw) : undefined,
  };
}

/** Anthropic's header set: `anthropic-ratelimit-requests-{limit,remaining,reset}`. `reset` is RFC 3339, not a duration. */
export function parseAnthropicRateLimitHeaders(headers: HeaderReader): ProviderRateLimitHint {
  const resetRaw = headers.get('anthropic-ratelimit-requests-reset');
  const resetAt = resetRaw !== null ? Date.parse(resetRaw) : NaN;

  return {
    limitRequests: parseIntHeader(headers, 'anthropic-ratelimit-requests-limit'),
    remainingRequests: parseIntHeader(headers, 'anthropic-ratelimit-requests-remaining'),
    resetAfterMs: Number.isFinite(resetAt) ? Math.max(0, resetAt - Date.now()) : undefined,
  };
}

/** Tries both known header shapes, returns whichever produced anything. Used for the reactive path, where the provider behind a thrown error isn't known. */
export function parseAnyRateLimitHeaders(headers: HeaderReader): ProviderRateLimitHint | undefined {
  const openai = parseOpenAIRateLimitHeaders(headers);
  if (openai.remainingRequests !== undefined || openai.limitRequests !== undefined) return openai;

  const anthropic = parseAnthropicRateLimitHeaders(headers);
  if (anthropic.remainingRequests !== undefined || anthropic.limitRequests !== undefined) {
    return anthropic;
  }

  return undefined;
}

/** Not exported: lets a hint travel attached to a response without appearing on its declared shape. Mirrors `fetch.ts`'s `err.headers`, for the success path. */
const RATE_LIMIT_HINT = Symbol('vernLLMProviderRateLimitHint');

/** Attaches a parsed hint onto a successful response value. No-op if `hint` is undefined. */
export function attachRateLimitHint(value: object, hint: ProviderRateLimitHint | undefined): void {
  if (!hint) return;

  Object.defineProperty(value, RATE_LIMIT_HINT, {
    value: hint,
    enumerable: false,
    configurable: true,
  });
}

/** Reads a hint attached by `attachRateLimitHint`, if any. */
export function readRateLimitHint(value: unknown): ProviderRateLimitHint | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return (value as { [RATE_LIMIT_HINT]?: ProviderRateLimitHint })[RATE_LIMIT_HINT];
}

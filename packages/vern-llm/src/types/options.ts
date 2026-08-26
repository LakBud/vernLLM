import type { CircuitBreakerOptions } from '../circuitBreaker.js';
import type { Logger } from '../logger.js';
import type { RateLimitOptions } from '../rateLimit.js';
import type { CacheAdapter } from './cache.js';
import type { LLMClient } from './client.js';
import type { OnEvent } from './events.js';
import type { FallbackOn, FallbackTarget } from './fallback.js';
import type { VernLLMMiddleware } from './middleware.js';
import type { OnUsage, OnUsageFailure } from './usage.js';

export interface VernLLMOptions {
  client: LLMClient;
  model: string;
  /**
   * Label for this provider in usage (`TokenUsage.provider`) and events.
   * Default `'primary'`.
   */
  name?: string;
  /** Max retries after the first attempt. Default 1 (2 attempts total) */
  maxRetries?: number;
  /** Per-attempt timeout in ms. Default 25000 */
  timeoutMs?: number;
  /**
   * For `stream: true` calls: max gap allowed between chunks once the
   * stream has opened, in ms. Resets on every chunk, including keep-alive
   * pings. `timeoutMs` only covers opening the stream and its first
   * chunk; this covers every gap after that. Also counts as a
   * circuit-breaker failure, unlike other mid-stream errors, since a
   * provider that streams one chunk then stalls should still trip it.
   * Default 30000. Pass 0 or negative to disable.
   */
  chunkIdleTimeoutMs?: number;
  /** Base delay for exponential backoff in ms. Default 500 */
  baseDelayMs?: number;
  /** Default max_tokens for calls that don't override it. Default 1000 */
  defaultMaxTokens?: number;
  /**
   * Default temperature for calls that don't override it. Default 0.2, not
   * the provider's own default. Pass `null` to omit `temperature` from the
   * request entirely, so the provider applies its own default instead.
   */
  defaultTemperature?: number | null;
  /**
   * Default reasoning effort for calls that don't override it. Not sent
   * when omitted, same as leaving `reasoningEffort` unset on a call. See
   * `budgetTokens`/`reasoningEffort` on `CallParams` for how the two
   * relate and how each adapter converts between them.
   */
  defaultReasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  /**
   * Default reasoning token budget for calls that don't override it. Not
   * sent when omitted. If both this and `defaultReasoningEffort` are set,
   * each adapter still prefers whichever field it natively understands,
   * same as at the per-call level.
   */
  defaultBudgetTokens?: number;
  /**
   * Enables debug logging of raw model output (logs up to 800 chars of each
   * response) and provider errors. Off by default. Only controls the
   * default `ConsoleLogger`: when a custom `logger` is supplied instead,
   * that logger's own `debug()` implementation decides whether messages
   * are emitted, and this option has no effect on it.
   */
  debug?: boolean;
  /**
   * Applied before every internal `logger.debug()` call: the raw output
   * logged on success, and the provider error logged on a failed call or
   * a failed stream open. This is the one piece of logging an app can't
   * intercept itself, since it's a direct call into `logger.debug`
   * rather than something routed through `onEvent`/`onUsage`; anything
   * caught elsewhere (events, `LLMError.cause`) already passes through
   * the app's own callback and can be redacted there instead. Runs
   * before `logger.debug()` regardless of whether that call ends up
   * emitting anything, so with a custom `logger`, `redact` still applies
   * even without `debug: true`; see `debug` for why. Default: identity
   * (no redaction).
   */
  redact?: (text: string) => string;
  /** Cache adapter for cachedCall. Defaults to an in-memory adapter */
  cache?: CacheAdapter;
  /** HTTP status codes that should fail fast without retrying. Default [400, 401, 403, 404, 422] */
  nonRetryableStatus?: number[];
  /** Custom JSON parser. Must return undefined/null on failure. Default: JSON.parse wrapped in try/catch */
  parseJson?: (content: string) => unknown;
  /** Called after every successful call with token usage, if the provider reports it */
  onUsage?: OnUsage;
  /**
   * Called when a provider response arrives but VernLLM's own post-processing
   * then fails, after usage data was already present in that response.
   * Separate from `onUsage`, which only fires on full success.
   *
   * For non-streaming calls, never fires for transport failures (timeout,
   * network error, non-retryable status), since no response means no usage
   * to report. For streaming calls, this is not guaranteed: a stream can
   * deliver a usage chunk and then fail later (e.g. an idle timeout waiting
   * for the final close), in which case this does fire.
   */
  onUsageFailure?: OnUsageFailure;
  /** Injectable logger. Defaults to a console-based logger gated by `debug` */
  logger?: Logger;
  /**
   * Enables a circuit breaker that short-circuits calls after repeated
   * consecutive failures, instead of continuing to hammer a down provider
   * Pass `true` for defaults, or an options object to tune threshold/cooldown
   */
  circuitBreaker?: boolean | CircuitBreakerOptions;
  /**
   * Reports retries and circuit-breaker state transitions as they happen.
   * Fire and forget: a throwing handler is caught and logged, and its
   * return value is never read, so it cannot influence the call.
   */
  onEvent?: OnEvent;
  /**
   * Client-side rate limiting. Queues calls locally to stay under the
   * configured requests/tokens-per-minute or concurrency caps, instead of
   * letting the provider reject them. Independent of the `Retry-After`
   * handling already applied to a provider 429: this avoids tripping the
   * limit in the first place. Omit for unlimited (the default).
   */
  rateLimit?: RateLimitOptions;
  /**
   * Ordered targets tried after the primary, in order, once it (and its
   * own retries) is exhausted or abandoned. Order is the policy: VernLLM
   * never reorders, scores, or selects between targets. Each target keeps
   * its own retry state, circuit breaker, and rate limiter, independent
   * of every other target's. A single `FallbackTarget` is equivalent to
   * `[target]`.
   */
  fallback?: FallbackTarget | FallbackTarget[];
  /**
   * Decides what happens after a target fails: `'next'` to move on to
   * the following target (or throw, if it was the last one), `'stop'` to
   * give up immediately without trying any remaining targets. Called
   * once per failed target, after that target's own retries are
   * exhausted or abandoned early, so `'retry'` is never a valid return
   * here. Defaults to `defaultFallbackOn`, which stops on
   * parse/validation/aborted/quota errors and on tool-contract failures
   * (the model ignoring the request, not the provider being unhealthy),
   * and moves on for everything else.
   */
  fallbackOn?: FallbackOn;
  /**
   * Transforms outgoing requests and/or wraps whole logical calls,
   * without touching retry, circuit breaker, or fallback internals.
   * Defaults to an empty array. See `VernLLMMiddleware` for the four
   * available hooks (`transform`, `wrap`, `onEvent`, `enabled`).
   */
  middleware?: VernLLMMiddleware[];
  /**
   * Bounds `transform` and a function `enabled`, the same way every
   * other blocking operation in the package is already bounded.
   * Overridable per middleware via that entry's own `timeoutMs`.
   * Default 5000.
   */
  middlewareTimeoutMs?: number;
}

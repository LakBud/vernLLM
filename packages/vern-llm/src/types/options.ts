import type { RetryBudgetOptions } from '../internal/retryBudget.js';
import type { CacheOption } from '../internal/utils/cache/cacheAdapter.utils.js';
import type { CircuitBreakerOption } from '../internal/utils/circuit-breaker/circuitBreakerAdapter.utils.js';
import type { RateLimitOption } from '../internal/utils/rate-limit/rateLimitAdapter.utils.js';
import type { Logger } from '../logger.js';
import type { DetectSoftFailure } from './call.js';
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
   * Max gap between stream chunks once open, in ms. Resets on every chunk, pings included. Unlike
   * other mid-stream errors it counts toward the breaker, so a provider that stalls after one chunk
   * still trips it. Default 30000; 0 or negative disables.
   */
  chunkIdleTimeoutMs?: number;
  /**
   * How long a `chunks` reader may stop pulling on a full buffer before it is detached. Its next
   * pull rejects with code `reader_stall_timeout`, while the stream finishes so `finalResult`
   * settles and its slot is freed. Off by default.
   */
  readerStallTimeoutMs?: number;
  /** Base delay for exponential backoff in ms. Default 500 */
  baseDelayMs?: number;
  /**
   * Longest `Retry-After` wait honored, in ms. Also caps `LLMError.retryAfterMs`. `0` retries at
   * once; `Infinity` removes the cap. Default 10000. Negative or NaN throws.
   */
  maxRetryAfterMs?: number;
  /** Default max_tokens for calls that don't override it. Default 1000 */
  defaultMaxTokens?: number;
  /**
   * Default temperature for calls that don't override it. Default 0.2, not
   * the provider's own default. Pass `null` to omit `temperature` from the
   * request entirely, so the provider applies its own default instead.
   */
  defaultTemperature?: number | null;
  /** Default reasoning effort for calls that don't set one. Not sent when omitted. */
  defaultReasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  /** Default reasoning token budget for calls that don't set one. Not sent when omitted. */
  defaultBudgetTokens?: number;
  /**
   * Logs raw model output (up to 800 chars) and provider errors. Only affects the default
   * `ConsoleLogger`; a custom `logger` decides for itself.
   */
  debug?: boolean;
  /**
   * Applied to model output and provider errors before VernLLM's own `logger.debug()` calls, the
   * one log path an app can't intercept. Runs even without `debug: true`, since a custom logger may
   * emit debug anyway. Default: no redaction.
   */
  redact?: (text: string) => string;
  /**
   * Cache for `cachedCall`. `{ maxSize, eviction }` configures the built in adapter; pass a
   * `CacheAdapter` for a real backend. Default in memory, 1000 entries, fifo.
   */
  cache?: CacheOption;
  /**
   * Reclassifies an otherwise successful result as a failure. Runs once per attempt after
   * validation; returning an `LLMErrorCode` fails the attempt through the normal retry and breaker
   * paths. A throwing hook is logged and ignored.
   */
  detectSoftFailure?: DetectSoftFailure;
  /** HTTP status codes that should fail fast without retrying. Default [400, 401, 402, 403, 404, 413, 422] */
  nonRetryableStatus?: number[];
  /** Custom JSON parser. Must return undefined/null on failure. Default: JSON.parse wrapped in try/catch */
  parseJson?: (content: string) => unknown;
  /** Called after every successful call with token usage, if the provider reports it */
  onUsage?: OnUsage;
  /**
   * Fires when a response carried usage but post-processing then failed. `onUsage` only fires on
   * success. A non-streaming transport failure has no usage to report; a stream can deliver usage
   * and fail later, which does fire this.
   */
  onUsageFailure?: OnUsageFailure;
  /**
   * Injectable logger. Defaults to a console-based logger gated by `debug`.
   * Pass `'silent'` to discard all log output without stubbing a Logger.
   */
  logger?: Logger | 'silent';
  /**
   * Short-circuits calls after repeated failures. `true` for defaults, options to tune, or a
   * `CircuitBreakerAdapter` for cross-process state.
   */
  circuitBreaker?: CircuitBreakerOption;
  /**
   * Reports retries and circuit-breaker state transitions as they happen.
   * Fire and forget: a throwing handler is caught and logged, and its
   * return value is never read, so it cannot influence the call.
   */
  onEvent?: OnEvent;
  /**
   * Client side rate limiting: queues calls to stay under request, token or concurrency caps rather
   * than letting the provider reject them. A config object builds an in-process limiter; pass a
   * `RateLimiterAdapter` for cross-process. Omit for unlimited.
   */
  rateLimit?: RateLimitOption;
  /**
   * Caps the share of this target's recent traffic that may be retries. Once `minCalls` calls land
   * in `windowMs` and the retry ratio reaches `retryRatio`, retries throw `retry_budget_exhausted`,
   * even while the breaker is closed. Not inherited by fallback targets.
   */
  retryBudget?: RetryBudgetOptions;
  /**
   * Targets tried in order after the primary is exhausted. VernLLM never reorders them. Each keeps
   * its own retries, breaker and limiter. A single target equals `[target]`.
   */
  fallback?: FallbackTarget | FallbackTarget[];
  /**
   * Whether a failed target moves on (`'next'`) or ends the call (`'stop'`). Called once per failed
   * target after its own retries. Defaults to `defaultFallbackOn`; see its docs for what it stops
   * on.
   */
  fallbackOn?: FallbackOn;
  /**
   * Request transforms and call wrappers that leave retry, breaker and fallback internals alone.
   * See `VernLLMMiddleware` for the hooks.
   */
  middleware?: VernLLMMiddleware[];
  /**
   * Bounds `transform` and a function `enabled`. Overridable per middleware with `timeoutMs`. `<=
   * 0` means unbounded. Default 5000.
   */
  middlewareTimeoutMs?: number;
}

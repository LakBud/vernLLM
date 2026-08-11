import type { CircuitBreakerOptions } from '../circuitBreaker.js';
import type { Logger } from '../logger.js';
import type { CacheAdapter } from './cache.js';
import type { LLMClient } from './client.js';
import type { OnEvent } from './events.js';
import type { OnUsage, OnUsageFailure } from './usage.js';

export interface VernLLMOptions {
  client: LLMClient;
  model: string;
  /**
   * Label for this provider in usage (`TokenUsage.provider`), events, and
   * log lines. Default `'primary'`.
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
  /** Enables debug logging of raw model output (logs up to 800 chars of each
   * response). Off by default */
  debug?: boolean;
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
}

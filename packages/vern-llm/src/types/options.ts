import type { CircuitBreakerOptions } from '../circuitBreaker.js';
import type { Logger } from '../logger.js';
import type { CacheAdapter } from './cache.js';
import type { LLMClient } from './client.js';
import type { OnUsage, OnUsageFailure } from './usage.js';

export interface VernLLMOptions {
  client: LLMClient;
  model: string;
  /** Max retries after the first attempt. Default 1 (2 attempts total) */
  maxRetries?: number;
  /** Per-attempt timeout in ms. Default 25000 */
  timeoutMs?: number;
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
   * Separate from `onUsage`, which only fires on full success. Never fires
   * for transport failures (timeout, network error, non-retryable status),
   * since no response means no usage to report.
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
}

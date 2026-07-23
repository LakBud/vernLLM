import type { CircuitBreakerOptions } from '../circuitBreaker.js';
import type { Logger } from '../logger.js';
import type { CacheAdapter } from './cache.js';
import type { LLMClient } from './client.js';
import type { OnUsage } from './usage.js';

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
  /** Enables debug logging of raw model output. Default: NODE_ENV !== 'production' */
  debug?: boolean;
  /** Cache adapter for cachedCall. Defaults to an in-memory adapter */
  cache?: CacheAdapter;
  /** HTTP status codes that should fail fast without retrying. Default [400, 401, 403] */
  nonRetryableStatus?: number[];
  /** Custom JSON parser. Must return undefined/null on failure. Default: JSON.parse wrapped in try/catch */
  parseJson?: (content: string) => unknown;
  /** Called after every successful call with token usage, if the provider reports it */
  onUsage?: OnUsage;
  /** Injectable logger. Defaults to a console-based logger gated by `debug` */
  logger?: Logger;
  /**
   * Enables a circuit breaker that short-circuits calls after repeated
   * consecutive failures, instead of continuing to hammer a down provider
   * Pass `true` for defaults, or an options object to tune threshold/cooldown
   */
  circuitBreaker?: boolean | CircuitBreakerOptions;
}

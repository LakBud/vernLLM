import { MAX_TIMER_DELAY_MS } from './internal/execution/utils/deadline.utils.js';
import { TokenBucket } from './internal/tokenBucket.js';
import {
  assertValidLimits,
  buildAimdOptions,
  buildEstimateFraction,
} from './internal/utils/rate-limit/rateLimitOptions.utils.js';
import { defaultEstimateTokens } from './internal/utils/rate-limit/tokenEstimate.utils.js';
import { LLMError } from './types/errors.js';

import type { ProviderRateLimitHint } from './internal/utils/rate-limit/rateLimitHint.utils.js';
import type { Logger } from './logger.js';
import type { LLMClient } from './types/client.js';

export { defaultEstimateTokens };

/** The request shape sent to `LLMClient['chat']['completions']['create']`, used for token estimation. */
export type WireRequest = Parameters<LLMClient['chat']['completions']['create']>[0];

/** Which configured bucket is currently blocking a call. */
export type RateLimitReason = 'concurrency' | 'rpm' | 'tpm';

export interface RateLimitOptions {
  /** Max requests per minute. Omit or pass 0 for unlimited. Otherwise a finite number of at least 1. */
  requestsPerMinute?: number;
  /**
   * Max tokens per minute. Enforced against a pre-flight estimate, then
   * reconciled against reported usage once the call completes. Omit or
   * pass 0 for unlimited. Otherwise a finite number of at least 1.
   */
  tokensPerMinute?: number;
  /** Max requests in flight at once, as a non-negative integer. Default 0, meaning unlimited. */
  maxConcurrent?: number;
  /**
   * Max time a call may sit queued waiting for capacity, in ms. Exceeding
   * it throws rather than hanging forever. Default 30000. Pass 0 to wait
   * indefinitely. At most 2147483647, the longest timer delay.
   */
  maxQueueMs?: number;
  /** Max queued calls before new ones reject immediately instead of queueing, as a non-negative integer. Default 0, unbounded. */
  maxQueueSize?: number;
  /**
   * Pre-flight token estimate for `tokensPerMinute`. Defaults to a
   * chars/4 heuristic over message text, a flat amount per image, plus
   * `max_tokens`.
   */
  estimateTokens?: (request: WireRequest) => number;
  /**
   * Scales the token estimate reserved against `tokensPerMinute`, since most calls use less than
   * `max_tokens`. Limiter bookkeeping only; `release` reconciles against real usage. Default 1,
   * must be above 0, clamped to 1.
   */
  estimateFraction?: number;
  /**
   * AIMD against the `requestsPerMinute` bucket. Omit for a fixed
   * ceiling, today's behavior. Requires `requestsPerMinute`; throws
   * without it.
   */
  aimd?: AimdOptions;
}

export interface AimdOptions {
  /** Added to the requests-per-minute ceiling on every clean release. */
  increaseBy: number;
  /** Multiplied against the ceiling on a rate-limit signal. Must be greater than `0` and at most `1`; clamped otherwise. */
  decreaseFactor: number;
  /** Floor the ceiling never shrinks below. */
  minCapacity: number;
  /** Ceiling the bucket never grows above. */
  maxCapacity: number;
  /**
   * Shrink proactively once a provider hint reports `remainingRequests`
   * at or below this, before a real 429 happens. Default 0, meaning
   * off.
   */
  proactiveFloor?: number;
}

export interface RateLimitState {
  /** Requests still available this window, or `undefined` if `requestsPerMinute` isn't configured. */
  requestsRemaining?: number;
  /** Tokens still available this window, or `undefined` if `tokensPerMinute` isn't configured. */
  tokensRemaining?: number;
  /** Concurrency slots currently in use, or `undefined` if `maxConcurrent` isn't configured. */
  concurrentInFlight?: number;
}

export interface RateLimitAcquireResult {
  /**
   * Frees the concurrency slot and reconciles tokens when `actualTokens` is given. Only the first
   * call counts. Call it in a `finally` so a failed attempt never leaks a slot.
   */
  release: (actualTokens?: number, success?: boolean) => void;
  /** How long this attempt waited in queue before capacity was available. */
  waitedMs: number;
  /** Which bucket was blocking this attempt just before it cleared, if any wait happened. */
  reason?: RateLimitReason;
}

/** Same amount used by `tryAcquireBuckets` and `scheduleWake`, stated once so the two can't drift apart. tpm spends `estimatedTokens`, everything else spends 1. */
function amountFor(reason: RateLimitReason, estimatedTokens: number): number {
  return reason === 'tpm' ? estimatedTokens : 1;
}

/** `requests`/`tokens` share this "per minute" refill formula. `concurrency` doesn't, it only refills via `release`. */
function buildPerMinuteBucket(capacityPerMinute: number | undefined): TokenBucket | undefined {
  if (!capacityPerMinute) return undefined;
  return new TokenBucket(capacityPerMinute, capacityPerMinute / 60_000);
}

/**
 * Minimum gap between AIMD shrinks, one full refill. A burst of 429s from calls already in flight
 * describes one overload, so shrinking per response would collapse the ceiling from a single spike.
 */
const AIMD_SHRINK_WINDOW_MS = 60_000;

/** One caller waiting for capacity, queued FIFO. */
interface Waiter {
  estimatedTokens: number;
  enqueuedAt: number;
  /** Reason recorded the last time this waiter was checked and found still blocked. */
  lastReason?: RateLimitReason;
  resolve: (result: RateLimitAcquireResult) => void;
  reject: (error: unknown) => void;
}

/**
 * What VernLLM needs from a limiter. Pass your own for cross-process coordination. Every method is
 * required; no-op the AIMD ones when unused, as `RateLimiter` does.
 */
export interface RateLimiterAdapter {
  estimate(request: WireRequest): number;
  acquire(estimatedTokens: number, signal?: AbortSignal): Promise<RateLimitAcquireResult>;
  signalRateLimit(): void;
  reactToRateLimitHint(hint: ProviderRateLimitHint | undefined): void;
  /** Optional: current bucket levels, for introspection. Omit if the adapter has no state worth reporting. */
  getState?(): RateLimitState;
  /** Optional: live bucket levels for `VernLLM.readRateLimitState()`, the async counterpart of `getState`. */
  readState?(): Promise<RateLimitState>;
  /** Optional: receives the instance's `Logger` once, when `VernLLM` wires this adapter in. */
  setLogger?(logger: Logger): void;
}

/**
 * Per target limiter: up to three buckets (requests, tokens, concurrency) behind one FIFO queue, so
 * a large call isn't starved by small ones. An omitted bucket never blocks.
 */
export class RateLimiter implements RateLimiterAdapter {
  private readonly requests?: TokenBucket;
  private readonly tokens?: TokenBucket;
  private readonly concurrency?: TokenBucket;

  /** Buckets in acquire precedence order (concurrency, rpm, tpm), omitted ones filtered out. Built once so order can't drift between `tryAcquireBuckets` and `scheduleWake`. */
  private readonly buckets: ReadonlyArray<{ reason: RateLimitReason; bucket: TokenBucket }>;

  private readonly maxQueueMs: number;
  private readonly maxQueueSize: number;
  private readonly estimateTokensFn: (request: WireRequest) => number;
  private readonly estimateFraction: number;
  private readonly aimd?: AimdOptions;

  private readonly queue: Waiter[] = [];

  /**
   * A scheduled recheck of the queue head when it waits on a bucket that refills by time, so the
   * queue doesn't wait for an unrelated acquire or release. A concurrency block only clears on
   * release.
   */
  private wakeTimer?: ReturnType<typeof setTimeout>;

  /** When AIMD last shrank the ceiling, see `AIMD_SHRINK_WINDOW_MS`. */
  private lastShrinkAt?: number;

  constructor(options: RateLimitOptions) {
    assertValidLimits(options);

    this.requests = buildPerMinuteBucket(options.requestsPerMinute);
    this.tokens = buildPerMinuteBucket(options.tokensPerMinute);

    if (options.maxConcurrent) {
      this.concurrency = new TokenBucket(options.maxConcurrent, 0);
    }

    this.buckets = (
      [
        { reason: 'concurrency', bucket: this.concurrency },
        { reason: 'rpm', bucket: this.requests },
        { reason: 'tpm', bucket: this.tokens },
      ] as const
    ).flatMap(({ reason, bucket }) => (bucket ? [{ reason, bucket }] : []));

    this.maxQueueMs = options.maxQueueMs ?? 30_000;
    this.maxQueueSize = options.maxQueueSize ?? 0;
    this.estimateTokensFn = options.estimateTokens ?? defaultEstimateTokens;
    this.estimateFraction = buildEstimateFraction(options.estimateFraction);
    this.aimd = buildAimdOptions(options.aimd);
  }

  /**
   * The token estimate reserved against `tokensPerMinute`, scaled by `estimateFraction`. The
   * request's `max_tokens` is never changed.
   */
  estimate(request: WireRequest): number {
    return Math.ceil(this.estimateTokensFn(request) * this.estimateFraction);
  }

  /**
   * Waits for capacity in every configured bucket, then takes from each.
   * The returned `release` gives the concurrency slot back and reconciles
   * the token bucket against real usage; it must run in a `finally` block.
   */
  async acquire(estimatedTokens: number, signal?: AbortSignal): Promise<RateLimitAcquireResult> {
    if (signal?.aborted) {
      throw new LLMError('LLM request aborted', 'aborted');
    }

    // Guards `estimatedTokens` even on this directly-exported entry point
    // (not just the `VernLLM.executeCall`/`executeStreamCall` call sites):
    // an unchecked NaN or negative value would poison a bucket's
    // `available` permanently, since `NaN < amount` is always false and
    // would make `tryTake` wrongly report success forever after.
    if (!Number.isFinite(estimatedTokens) || estimatedTokens < 0) {
      throw new LLMError(
        `estimatedTokens must be a finite, non-negative number, got ${String(estimatedTokens)}`,
        'invalid_params',
      );
    }

    // A request over the bucket's own ceiling can never be satisfied by
    // any amount of waiting, refill included, so failing fast here also
    // avoids permanently stalling every waiter queued behind it in FIFO.
    if (this.tokens && estimatedTokens > this.tokens.getCapacity()) {
      throw new LLMError(
        `estimatedTokens (${estimatedTokens}) exceeds the configured tokensPerMinute capacity (${this.tokens.getCapacity()}); this call could never acquire capacity.`,
        'rate_limited',
        { code: 'rate_limit_capacity_exceeded' },
      );
    }

    // Fast path: nothing already queued, so try to go straight through
    // rather than paying queue bookkeeping for the common, uncontended case.
    if (this.queue.length === 0) {
      const attempt = this.tryAcquireBuckets(estimatedTokens);

      if (attempt.ok) {
        return { release: this.makeRelease(estimatedTokens), waitedMs: 0 };
      }

      // No maxQueueSize check needed here: the queue is empty (this
      // branch's own condition), so enqueueing this one waiter can never
      // exceed any maxQueueSize > 0. The check below only becomes
      // reachable once the queue is non-empty.
      return this.enqueue(estimatedTokens, attempt.reason, signal);
    }

    if (this.maxQueueSize > 0 && this.queue.length >= this.maxQueueSize) {
      throw this.queueFullError();
    }

    return this.enqueue(estimatedTokens, undefined, signal);
  }

  private queueFullError(): LLMError {
    return new LLMError('Rate limit queue is full', 'rate_limited', {
      code: 'rate_limit_queue_full',
    });
  }

  private enqueue(
    estimatedTokens: number,
    initialReason: RateLimitReason | undefined,
    signal?: AbortSignal,
  ): Promise<RateLimitAcquireResult> {
    return new Promise<RateLimitAcquireResult>((resolvePromise, rejectPromise) => {
      const waiter: Waiter = {
        estimatedTokens,
        enqueuedAt: Date.now(),
        lastReason: initialReason,
        resolve: (result) => {
          cleanup();
          resolvePromise(result);
        },
        reject: (error) => {
          cleanup();

          // The removed waiter may have been the head a wake was scheduled for, so drain now rather
          // than waiting on a stale timer.
          if (this.wakeTimer) {
            clearTimeout(this.wakeTimer);
            this.wakeTimer = undefined;
          }
          this.drain();

          rejectPromise(error);
        },
      };

      let queueTimer: ReturnType<typeof setTimeout> | undefined;

      const onAbort = () => {
        waiter.reject(new LLMError('LLM request aborted', 'aborted'));
      };

      const cleanup = () => {
        if (queueTimer) clearTimeout(queueTimer);
        signal?.removeEventListener('abort', onAbort);

        const index = this.queue.indexOf(waiter);
        // Defensive: each waiter is removed at most once, so `index` is always found. Guards
        // `splice(-1, 1)` against removing another waiter if that ever changes.
        /* v8 ignore next */
        if (index !== -1) this.queue.splice(index, 1);
      };

      if (this.maxQueueMs > 0) {
        queueTimer = setTimeout(() => {
          waiter.reject(
            new LLMError(
              'Rate limit queue timed out before capacity was available',
              'rate_limited',
              {
                code: 'rate_limit_queue_timeout',
              },
            ),
          );
        }, this.maxQueueMs);
      }

      signal?.addEventListener('abort', onAbort, { once: true });

      this.queue.push(waiter);
      this.drain();
    });
  }

  /** Takes from every configured bucket as one atomic unit, in `this.buckets`' order. Rolls back whatever was already taken if any bucket lacks capacity. */
  private tryAcquireBuckets(
    estimatedTokens: number,
  ): { ok: true } | { ok: false; reason: RateLimitReason } {
    const taken: Array<{ bucket: TokenBucket; amount: number }> = [];

    for (const { reason, bucket } of this.buckets) {
      const amount = amountFor(reason, estimatedTokens);

      if (!bucket.tryTake(amount)) {
        for (const entry of taken) entry.bucket.give(entry.amount);
        return { ok: false, reason };
      }

      taken.push({ bucket, amount });
    }

    return { ok: true };
  }

  /** Drains the queue head first. Stops at the first waiter that still can't proceed, so no one is starved out of turn. */
  private drain(): void {
    while (this.queue.length > 0) {
      const waiter = this.queue[0] as Waiter;
      const attempt = this.tryAcquireBuckets(waiter.estimatedTokens);

      if (!attempt.ok) {
        waiter.lastReason = attempt.reason;
        this.scheduleWake(attempt.reason, waiter.estimatedTokens);
        return;
      }

      const waitedMs = Date.now() - waiter.enqueuedAt;

      waiter.resolve({
        release: this.makeRelease(waiter.estimatedTokens),
        waitedMs,
        reason: waiter.lastReason,
      });
    }
  }

  /**
   * Schedules one recheck for when the bucket blocking the head should have capacity. No-op for a
   * concurrency block or while a wake is pending.
   */
  private scheduleWake(reason: RateLimitReason, estimatedTokens: number): void {
    if (this.wakeTimer) return;
    if (reason === 'concurrency') return;

    const bucket = this.buckets.find((entry) => entry.reason === reason)?.bucket;
    const ms = bucket?.msUntilAvailable(amountFor(reason, estimatedTokens));

    // Defensive: validation keeps every per minute ceiling at 1 or more, so
    // refill never stops and the wait is always finite. Guards a timer
    // with an Infinity/NaN delay, which fires at once, if that changes.
    /* v8 ignore next */
    if (ms === undefined || !Number.isFinite(ms)) return;

    // Capped at the timer limit. `drain()` rereads bucket state on every wake, so an early wake
    // just reschedules.
    const delay = Math.min(Math.max(1, Math.ceil(ms)), MAX_TIMER_DELAY_MS);

    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      this.drain();
    }, delay);
  }

  /**
   * The one-shot release for an acquired slot. Concurrency is given back, requests only recover by
   * refill, and tokens are reconciled against real usage. AIMD grows only when `success` is true,
   * so a failed attempt can't undo a shrink.
   */
  private makeRelease(estimatedTokens: number): (actualTokens?: number, success?: boolean) => void {
    let released = false;

    return (actualTokens?: number, success = false) => {
      if (released) return;
      released = true;

      this.concurrency?.give(1);

      // A NaN would poison the bucket and silently stop limiting, so a non-finite `actualTokens`
      // skips reconciliation and keeps the safer estimated debit.
      if (this.tokens && actualTokens !== undefined && Number.isFinite(actualTokens)) {
        this.tokens.give(estimatedTokens - actualTokens);
      }

      if (success) this.growOnSuccess();
      this.drain();
    };
  }

  /** Shared guard and resize call behind both AIMD halves below; only the arithmetic differs. */
  private resizeRequestsCeiling(next: (aimd: AimdOptions, current: number) => number): void {
    if (!this.aimd || !this.requests) return;

    this.requests.resize(next(this.aimd, this.requests.getCapacity()));
  }

  /** AIMD's additive-increase half: grows the ceiling by `aimd.increaseBy` on a clean release. No-op without `aimd`/`requestsPerMinute`. */
  private growOnSuccess(): void {
    this.resizeRequestsCeiling((aimd, current) =>
      Math.min(current + aimd.increaseBy, aimd.maxCapacity),
    );
  }

  /**
   * AIMD's decrease, on a real 429 or a low remaining hint. Only adjusts the ceiling, never throws.
   * Shrinks at most once per `AIMD_SHRINK_WINDOW_MS`.
   */
  signalRateLimit(): void {
    if (!this.aimd || !this.requests) return;

    const now = Date.now();

    // A clock that moved backwards reads as a new window, so a skewed
    // `lastShrinkAt` can never block shrinking for longer than one window.
    if (
      this.lastShrinkAt !== undefined &&
      now >= this.lastShrinkAt &&
      now - this.lastShrinkAt < AIMD_SHRINK_WINDOW_MS
    ) {
      return;
    }

    this.lastShrinkAt = now;
    this.resizeRequestsCeiling((aimd, current) =>
      Math.max(current * aimd.decreaseFactor, aimd.minCapacity),
    );
  }

  /**
   * AIMD's proactive entry point: shrinks via `signalRateLimit()` if
   * `hint.remainingRequests` is at or below `aimd.proactiveFloor`.
   */
  reactToRateLimitHint(hint: ProviderRateLimitHint | undefined): void {
    if (!this.aimd || !hint || hint.remainingRequests === undefined) return;

    // Defensive: `buildAimdOptions` always normalizes `proactiveFloor` to
    // a number (`?? 0`) at construction, so `this.aimd.proactiveFloor` is
    // never actually undefined here. Guards against a `NaN`/`undefined`
    // floor silently breaking the comparison below if that invariant is
    // ever broken by a future change.
    /* v8 ignore next */
    const floor = this.aimd.proactiveFloor ?? 0;
    if (floor > 0 && hint.remainingRequests <= floor) {
      this.signalRateLimit();
    }
  }

  /**
   * Current bucket levels, read live rather than cached. `concurrency`
   * tracks free slots internally, so `concurrentInFlight` is reported as
   * `capacity - available`, the inverse of what the bucket itself holds.
   */
  getState(): RateLimitState {
    return {
      requestsRemaining: this.requests?.getAvailable(),
      tokensRemaining: this.tokens?.getAvailable(),
      concurrentInFlight: this.concurrency
        ? this.concurrency.getCapacity() - this.concurrency.getAvailable()
        : undefined,
    };
  }
}

import { LLMError } from './types/errors.js';

import type { LLMClient } from './types/client.js';

/** The request shape sent to `LLMClient['chat']['completions']['create']`, used for token estimation. */
export type WireRequest = Parameters<LLMClient['chat']['completions']['create']>[0];

/** Which configured bucket is currently blocking a call. */
export type RateLimitReason = 'concurrency' | 'rpm' | 'tpm';

export interface RateLimitOptions {
  /** Max requests per minute. Omit for unlimited. */
  requestsPerMinute?: number;
  /**
   * Max tokens per minute. Enforced against a pre-flight estimate, then
   * reconciled against reported usage once the call completes. Omit for
   * unlimited.
   */
  tokensPerMinute?: number;
  /** Max requests in flight at once. Default 0, meaning unlimited. */
  maxConcurrent?: number;
  /**
   * Max time a call may sit queued waiting for capacity, in ms. Exceeding
   * it throws rather than hanging forever. Default 30000. Pass 0 to wait
   * indefinitely.
   */
  maxQueueMs?: number;
  /** Max queued calls before new ones reject immediately instead of queueing. Default 0, unbounded. */
  maxQueueSize?: number;
  /**
   * Pre-flight token estimate for `tokensPerMinute`. Defaults to a
   * chars/4 heuristic over message content plus `max_tokens`.
   */
  estimateTokens?: (request: WireRequest) => number;
}

export interface RateLimitAcquireResult {
  /**
   * Releases the concurrency slot this attempt held and reconciles the
   * token bucket against real usage, when `actualTokens` is supplied.
   * Idempotent: only the first call does anything. Must run in a
   * `finally` block so a slot is never leaked on a failed attempt.
   */
  release: (actualTokens?: number) => void;
  /** How long this attempt waited in queue before capacity was available. */
  waitedMs: number;
  /** Which bucket was blocking this attempt just before it cleared, if any wait happened. */
  reason?: RateLimitReason;
}

/** Default `estimateTokens`: chars/4 over every message's content, plus the requested `max_tokens`. */
export function defaultEstimateTokens(request: WireRequest): number {
  const messagesChars = request.messages.reduce((sum, message) => {
    const content = (message as { content?: unknown }).content;

    if (typeof content === 'string') return sum + content.length;
    if (content === undefined || content === null) return sum;

    try {
      return sum + JSON.stringify(content).length;
    } catch {
      return sum;
    }
  }, 0);

  return Math.ceil(messagesChars / 4) + (request.max_tokens ?? 0);
}

/**
 * A capacity that refills continuously. Used for requests per minute and
 * tokens per minute, where `refillPerMs` is `capacity / 60000`, and for
 * concurrency, where `refillPerMs` is 0 and every release calls
 * `give(1)` instead of relying on the clock.
 */
class TokenBucket {
  private available: number;
  private lastRefill = Date.now();

  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number,
  ) {
    this.available = capacity;
  }

  private refill(): void {
    if (this.refillPerMs === 0) return;

    const now = Date.now();
    const elapsedMs = now - this.lastRefill;

    // A backward clock adjustment (NTP correction, VM migration, etc.)
    // makes `elapsedMs` negative, which would otherwise reduce `available`
    // on the next line, rate-limiting harder than configured for no
    // real-world reason. Treat a negative elapsed time as no time having
    // passed instead: `available` just doesn't grow this tick, rather
    // than shrinking, and `lastRefill` still advances so a subsequent
    // forward-moving `now` measures from here, not from the skewed past.
    this.available = Math.min(
      this.capacity,
      this.available + Math.max(0, elapsedMs) * this.refillPerMs,
    );
    this.lastRefill = now;
  }

  /** Refills, then takes `amount` if available. Leaves the bucket untouched if it can't. */
  tryTake(amount: number): boolean {
    this.refill();

    if (this.available < amount) return false;

    this.available -= amount;
    return true;
  }

  /**
   * Refills, then reports how many ms until this bucket could supply
   * `amount`, assuming nothing else takes from it meanwhile. Returns 0 if
   * it already can, `Infinity` if it never will on its own (a
   * concurrency bucket, `refillPerMs === 0`, only frees via `give`).
   */
  msUntilAvailable(amount: number): number {
    this.refill();

    if (this.available >= amount) return 0;
    if (this.refillPerMs === 0) return Infinity;

    return (amount - this.available) / this.refillPerMs;
  }

  /**
   * Gives capacity back. Not floored at 0: a bad token-usage estimate can
   * push `available` negative, and it self-corrects on the next refill
   * rather than being clamped away immediately. Only ceilinged at
   * `capacity`, so a give can never overfill the bucket.
   */
  give(amount: number): void {
    this.available = Math.min(this.capacity, this.available + amount);
  }

  /** The bucket's ceiling, e.g. so a request that could never fit can fail fast instead of queueing forever. */
  getCapacity(): number {
    return this.capacity;
  }
}

/**
 * `setTimeout` silently clamps any delay above this (~24.8 days) instead
 * of erroring, so an uncapped delay derived from a very small
 * `requestsPerMinute`/`tokensPerMinute` could wrap around to firing
 * almost immediately instead of waiting. Mirrors the same guard in
 * `withTimeout`/`withChunkIdleTimeout`.
 */
const MAX_WAKE_DELAY_MS = 2_147_483_647;

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
 * Per-target rate limiter. Up to three buckets (requests/min, tokens/min,
 * concurrency) behind one FIFO queue, so a large call isn't starved by a
 * stream of small ones. Any bucket omitted from `options` has infinite
 * capacity and never blocks.
 */
export class RateLimiter {
  private readonly requests?: TokenBucket;
  private readonly tokens?: TokenBucket;
  private readonly concurrency?: TokenBucket;

  private readonly maxQueueMs: number;
  private readonly maxQueueSize: number;
  private readonly estimateTokensFn: (request: WireRequest) => number;

  private readonly queue: Waiter[] = [];

  /**
   * A single scheduled re-check for the head of the queue when it's
   * blocked on a bucket that refills on its own clock (rpm/tpm), so a
   * queue that nobody calls `acquire`/`release` on again isn't stuck
   * forever waiting for an external trigger to re-drain it. Not needed
   * for a concurrency block, which only clears via `release`.
   */
  private wakeTimer?: ReturnType<typeof setTimeout>;

  constructor(options: RateLimitOptions) {
    if (options.requestsPerMinute) {
      this.requests = new TokenBucket(
        options.requestsPerMinute,
        options.requestsPerMinute / 60_000,
      );
    }

    if (options.tokensPerMinute) {
      this.tokens = new TokenBucket(options.tokensPerMinute, options.tokensPerMinute / 60_000);
    }

    if (options.maxConcurrent) {
      this.concurrency = new TokenBucket(options.maxConcurrent, 0);
    }

    this.maxQueueMs = options.maxQueueMs ?? 30_000;
    this.maxQueueSize = options.maxQueueSize ?? 0;
    this.estimateTokensFn = options.estimateTokens ?? defaultEstimateTokens;
  }

  /** Pre-flight token estimate for a request, per the configured (or default) heuristic. */
  estimate(request: WireRequest): number {
    return this.estimateTokensFn(request);
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

          // The removed waiter may have been the head a wakeTimer was
          // scheduled around (or, for a concurrency block, the head with
          // no timer scheduled at all). Either way, re-drain immediately
          // so a successor with different requirements is evaluated now
          // instead of waiting on a stale timer or an unrelated
          // acquire/release call to trigger it.
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

  /**
   * Checks and takes from every configured bucket as one atomic unit: if
   * any bucket lacks capacity, whatever was already taken from the
   * earlier ones in this attempt is rolled back before reporting which
   * bucket blocked.
   */
  private tryAcquireBuckets(
    estimatedTokens: number,
  ): { ok: true } | { ok: false; reason: RateLimitReason } {
    const taken: Array<{ bucket: TokenBucket; amount: number }> = [];

    const take = (bucket: TokenBucket | undefined, amount: number) => {
      if (!bucket) return true;
      if (!bucket.tryTake(amount)) return false;

      taken.push({ bucket, amount });
      return true;
    };

    if (!take(this.concurrency, 1)) {
      return { ok: false, reason: 'concurrency' };
    }

    if (!take(this.requests, 1)) {
      for (const entry of taken) entry.bucket.give(entry.amount);
      return { ok: false, reason: 'rpm' };
    }

    if (!take(this.tokens, estimatedTokens)) {
      for (const entry of taken) entry.bucket.give(entry.amount);
      return { ok: false, reason: 'tpm' };
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
   * Schedules a one-shot re-check of the queue for whenever the bucket
   * that's currently blocking the head waiter should next have enough
   * capacity. A no-op for a concurrency block (only `release` can clear
   * that) or while a wake is already pending.
   */
  private scheduleWake(reason: RateLimitReason, estimatedTokens: number): void {
    if (this.wakeTimer) return;

    const ms =
      reason === 'rpm'
        ? this.requests?.msUntilAvailable(1)
        : reason === 'tpm'
          ? this.tokens?.msUntilAvailable(estimatedTokens)
          : undefined;

    if (ms === undefined || !Number.isFinite(ms)) return;

    // Capped, not just clamped-by-omission: `drain()` re-derives the
    // real remaining wait from live bucket state on every firing (it
    // doesn't trust the delay that got it there), so a wake that fires
    // early because the true wait exceeded the cap just re-schedules
    // correctly from where the bucket actually is, rather than looping
    // on a delay that never shrinks.
    const delay = Math.min(Math.max(1, Math.ceil(ms)), MAX_WAKE_DELAY_MS);

    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      this.drain();
    }, delay);
  }

  /**
   * Builds the one-shot release closure for an acquired slot. Only the
   * concurrency bucket is given back on release; the requests-per-minute
   * bucket is a real spend that only recovers via its own refill, and the
   * tokens bucket is reconciled against `actualTokens` rather than fully
   * refunded, since real tokens really were spent.
   */
  private makeRelease(estimatedTokens: number): (actualTokens?: number) => void {
    let released = false;

    return (actualTokens?: number) => {
      if (released) return;
      released = true;

      this.concurrency?.give(1);

      // An invalid `actualTokens` (e.g. NaN from a malformed usage
      // report) must not reach `give`: `Math.min(capacity, available +
      // NaN)` is NaN, and a NaN `available` poisons every future
      // `tryTake` on that bucket (any comparison against NaN is false,
      // so it would look permanently under capacity and rate limiting
      // would silently stop happening). Falling back to no reconciliation
      // at least keeps the estimated debit, the safe direction to err.
      if (this.tokens && actualTokens !== undefined && Number.isFinite(actualTokens)) {
        this.tokens.give(estimatedTokens - actualTokens);
      }

      this.drain();
    };
  }
}

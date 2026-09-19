---
'vern-llm': minor
---

Fix a circuit breaker that could stay half-open forever, let circuit breaker and rate limiter adapters with remote state cooperate with `VernLLM` (an async `prepare` step, live `readState` reads), and let them follow the instance's `logger`.

A half-open breaker lets one trial call through. If that call ended in an error the breaker deliberately ignores (quota, validation, a caller abort, a local rate limit rejection, a failure before dispatch), nothing recorded an outcome, so the trial slot stayed claimed and every later call was rejected with "no trial available". `VernLLM` now hands the slot back whenever a call ends without a recorded outcome, so the next call becomes the new trial.

`assertClosed` has to decide synchronously, so an adapter whose real state is remote (Redis) can only decide from a local copy: a key it has never seen reads as closed, and the first call after a cooldown is rejected while a background check wins the trial. A new optional `prepare` on `CircuitBreakerAdapter` fixes this. `VernLLM` awaits it right before `assertClosed`, so the adapter can refresh its copy first. It never blocks or fails a call: a rejection, or taking longer than `prepareTimeoutMs` (default 1000), is logged as a warning and the call carries on with the adapter's local state. A call aborted while waiting rejects with `aborted`.

Adapters can also implement `readState` for a live read, surfaced as `VernLLM.readCircuitStates()` and `VernLLM.readRateLimitState()`. Both fall back to `getState` when an adapter has no `readState`. Finally, `recordSuccess`, `recordFailure` and `releaseTrial` are fire and forget, so if an adapter hands back a promise from one of them and it rejects, `VernLLM` now logs it instead of leaving an unhandled rejection that could end the process after the call had already succeeded.

```ts
import type { CircuitBreakerAdapter, Logger, RateLimiterAdapter } from 'vern-llm';

// The new optional members, shown on their own. Your adapter still
// implements the rest of the interface as before.
const breaker: Pick<
  CircuitBreakerAdapter,
  'prepare' | 'prepareTimeoutMs' | 'readState' | 'releaseTrial' | 'setLogger'
> = {
  async prepare(model, context) {
    // Refresh local state from the remote store. Return quickly when it is
    // already fresh, this runs on every call's path.
  },
  prepareTimeoutMs: 250,
  async readState(model) {
    return 'closed'; // the live state, not a local copy
  },
  releaseTrial(model, context) {
    // Give back the trial slot this call claimed. Must be idempotent, and a
    // no-op for a call that holds no slot.
  },
  setLogger(logger: Logger) {
    // Called once with the instance's own logger.
  },
};

const limiter: Pick<RateLimiterAdapter, 'readState' | 'setLogger'> = {
  async readState() {
    return { requestsRemaining: 42 }; // live levels
  },
  setLogger(logger: Logger) {
    // Same handoff, so background failures follow `logger` and `'silent'`.
  },
};

const live = await llm.readCircuitStates();
const levels = await llm.readRateLimitState();
```

Existing code keeps compiling: every new member is optional, and an adapter that omits them behaves exactly as before, with no extra wait. Runtime differences to know about. The built in `CircuitBreaker` now treats a call's half-open permit as spent once its success or failure is recorded, so a duplicate outcome for the same call is no longer counted twice. A custom adapter whose `prepare`, `readState`, `releaseTrial` or `setLogger` is present but not a function, or whose `prepareTimeoutMs` is not a finite number greater than 0, now fails validation at construction, like its other optional members. The same applies to a rate limiter adapter's `readState`.

---
'vern-llm': minor
---

Add `CircuitBreakerAdapter`, a pluggable interface for `circuitBreaker`, the same pattern `RateLimiterAdapter` already offers for `rateLimit`. Pass a full adapter (a cross process breaker, for example a Redis backed one) instead of `CircuitBreakerOptions`, and VernLLM drives it the same way it drives the built in `CircuitBreaker`.

`CircuitBreaker` now implements `CircuitBreakerAdapter`, so existing code using `circuitBreaker: { ... }` or `circuitBreaker: true` is unchanged.

```ts
import { VernLLM, fromOpenAI, type CircuitBreakerAdapter } from 'vern-llm';

const myBreaker: CircuitBreakerAdapter = {
  assertClosed(model, context) {
    /* throw an LLMError('circuit_open', ...) when tripped */
  },
  recordSuccess(model, context) {
    /* ... */
  },
  recordFailure(model, context, code) {
    /* ... */
  },
  onStateChange(from, to, consecutiveFailures, model) {
    /* required, but a no-op () => {} is a valid implementation */
  },
  // all four below are optional
  getState(model) {
    return 'closed';
  },
  getFailureBreakdown(model) {
    return {};
  },
  open(model, context) {
    /* ... */
  },
  close(model, context) {
    /* ... */
  },
};

const client = new VernLLM({
  provider: fromOpenAI({ apiKey }),
  circuitBreaker: myBreaker,
});
```

`assertClosed`, `recordSuccess`, `recordFailure`, and `onStateChange` are required, four members for four things, the same shape as `RateLimiterAdapter`'s four required methods. `getState`, `getFailureBreakdown`, `isolateByModel`, `open`, and `close` are all optional, plain data or opt-in control an adapter can simply skip. `llm.getCircuitState()`/`getFailureBreakdown()` return `undefined` and `llm.openCircuit()`/`closeCircuit()` become no-ops for a target whose adapter doesn't implement the corresponding member, the same as a target with no breaker configured at all.

`open`/`close` stay optional rather than required on purpose: they hand VernLLM the ability to force a transition from outside, which a distributed adapter may deliberately not want to grant, one caller unilaterally forcing every replica open, for example.

`onStateChange` is required rather than optional, unlike the other five. It's the one member whose absence has no visible symptom: an adapter missing it still trips and recovers correctly, the only effect is that `circuit_state` events silently never fire for that target, which the middleware ecosystem's `onEvent` and any alerting built on it depend on. Requiring it turns a silent omission into an explicit choice, `onStateChange: () => {}` is a perfectly fine implementation for an adapter that genuinely doesn't want the notification. VernLLM wraps whatever you provide the same way it wraps the built in class's: reports the `circuit_state` event first, then calls your handler, even a no-op one.

Passing an object that implements some but not all four required members throws `LLMError('invalid_params')` at construction, naming what's missing, rather than surfacing later as a confusing runtime error. `onStateChange` alone, with none of `assertClosed`/`recordSuccess`/`recordFailure`, is never treated as an incomplete adapter, since it's a legitimate `CircuitBreakerOptions` field too (`circuitBreaker: { threshold: 5, onStateChange: fn }` keeps working exactly as before). A present but non function `getState`/`getFailureBreakdown`/`open`/`close` also throws at construction, the same treatment `RateLimiterAdapter`'s `getState` already gets.

One thing to note: sharing one adapter instance across more than one target is supported. Every sharing target still gets its own correctly tagged `circuit_state` event, and your original `onStateChange` fires exactly once per real transition, not once per sharing target. VernLLM logs a `[VernLLM] circuitBreaker: this adapter instance is already wired...` warning the first time it notices sharing, once per adapter, not once per additional target, so accidental sharing is visible without being noisy.

Minor, not breaking. Every existing `circuitBreaker` option keeps working exactly as before.

Also exports `CircuitBreakerAdapter`, `CircuitBreakerCallContext`, and `CircuitBreakerStateChangeHandler` from the package root, alongside the existing `CircuitBreaker`/`CircuitBreakerOptions`/`CircuitState` exports.

Fixes a sharing bug found in review: passing the same `CircuitBreakerAdapter` instance to more than one target previously chained `onStateChange` wrapping one call deeper on every build, an unbounded, invisible call chain over the life of the process. It now installs exactly one dispatcher per adapter instance, every sharing target still gets its own correctly tagged `circuit_state` event, and the adapter's own original `onStateChange` fires exactly once per real transition, not once per sharing target. A `[VernLLM] circuitBreaker: this adapter instance is already wired...` warning is logged the first time sharing is detected.

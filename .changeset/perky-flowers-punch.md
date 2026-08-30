---
'vern-llm': minor
---

Add `tripping` to `CircuitBreakerOptions`, so a circuit can open off a rolling failure ratio
instead of only a fixed streak of consecutive failures.

Today, `threshold` counts consecutive failures and opens the circuit once that streak is reached.
That's a poor fit for a provider whose failures are frequent but not literally back to back:
`tripping` lets a caller open the circuit once a failure ratio is reached over a trailing window
instead:

```ts
const llm = new VernLLM({
  client: fromOpenAI(openai),
  model: 'gpt-4o',
  circuitBreaker: {
    cooldownMs: 30_000,
    tripping: { kind: 'rolling', windowMs: 60_000, minCalls: 20, failureRatio: 0.5 },
  },
});
```

`{ kind: 'consecutive', threshold }` (the default, matching `threshold` on its own) opens after
that many failures in a row. `{ kind: 'rolling', windowMs, minCalls, failureRatio }` opens once at
least `minCalls` calls have landed in the trailing `windowMs` and the failure ratio among them
reaches `failureRatio`. A hand built `TrippingPolicy` is the escape hatch for anything else, no
class required, a plain object satisfying the interface works:

```ts
interface TrippingPolicy {
  onSuccess(key: string): void;
  onFailure(key: string): boolean; // true opens the circuit for key
  reset(key: string): void;
  forget?(key: string): void; // optional: called when key's bucket is discarded
}
```

`key` is the resolved model under `isolateByModel`, or one fixed shared key otherwise. Exactly one
instance of a policy is ever constructed, so `isolateByModel` isolation comes entirely from `key`:
a policy that tracks its own state per key gets real per-model isolation automatically, no special
handling needed, the same way the two built-in policies already do internally. A policy that
ignores `key` and tracks one flat counter stays intentionally shared across every model, a choice
the policy makes rather than a limitation of `isolateByModel` itself.

`onStateChange`, the `circuit_state` event, and the open-circuit error message still report a true
consecutive-failure count regardless of which policy is configured, since that count is tracked
independently of whatever a policy uses to decide when to trip.

Omitted (the default), behavior is unchanged: consecutive-failure tripping against `threshold`.

Also reorganizes `circuitBreaker.ts` into clearly labeled sections (options, cooldown backoff,
tripping policy, bucket state, the `CircuitBreaker` class), with the class's public API methods
grouped separately from its private helpers. Pure code motion alongside the feature above: no
additional behavior, type, or export changes.

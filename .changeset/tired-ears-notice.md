---
'vern-llm': minor
---

Add `getFailureBreakdown` to `VernLLM`, `CircuitBreaker`, and the internal call executor, exposing
why a circuit's failures are happening rather than just how many.

Today, a circuit's failure count is a single number: consecutive failures crossing `threshold`.
That number does not distinguish a run of timeouts from a run of 500s from a run of empty
responses, all of which count the same way toward opening the circuit. `getFailureBreakdown` reports
those reasons separately:

```ts
llm.getFailureBreakdown();
// { server_error: 3, request_timeout: 1 }

llm.getFailureBreakdown({ index: 1 }); // first fallback target
llm.getFailureBreakdown({ model: 'gpt-4o' }); // for a target with isolateByModel
```

It takes the same `target: { index?, model? }` shape as `getCircuitState`, returns `undefined` for
a target with no breaker configured, and `{}` for a bucket that hasn't failed yet. A failure that
carried no `LLMErrorCode` attributes to `'unknown'`.

The breakdown is attribution only, it never decides whether the circuit trips, and clears whenever
the bucket does: on a successful call, a successful half-open trial, or a manual `closeCircuit()`.

No breaking changes. `CircuitBreaker.recordFailure`'s existing `code` parameter, added in an earlier
release to carry this data without a signature change, is now actually read.

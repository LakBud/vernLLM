---
'vern-llm': patch
---

Reorganized the package's internal file structure. No public API changes.

`VernLLM` previously held request building, retry, the circuit breaker, the rate limiter, and cache orchestration all inline in one class. It now delegates to `CallExecutor` (request building, retry, breaker, limiter) and `CacheOrchestrator` (cache reads/writes and in flight coalescing), leaving `VernLLM` itself as constructor wiring plus the public `call`/`cachedCall`/`deleteCache`/`getCircuitState` surface.

`src/internal/` is now grouped by the subsystem that owns each file: `internal/execution/` for everything `CallExecutor` needs (`callExecutor.ts`, `requestBuilder.ts`, `streamAccumulator.ts`, `retry.utils.ts`, `errors.utils.ts`, `wire.utils.ts`, `parse.utils.ts`), `internal/cache/` for everything `CacheOrchestrator` needs (`cacheOrchestrator.ts`, `cache.utils.ts`, `replay.utils.ts`), and `internal/circuitBreaker.utils.ts`/`internal/usage.utils.ts` staying loose since `VernLLM` uses them directly. `sse.ts`, `imageFormat.ts`, and `nativeStructuredOutput.ts` moved under `src/adapters/internal/`, since only the provider adapters ever imported them.

The streaming accumulator (chunk buffering, backlog eviction, live delivery to a waiting consumer) is now its own module, `streamAccumulator.ts`, taking `onStreamSuccess`/`onStreamFailure`/`finalize` callbacks instead of reaching back into `CallExecutor`'s breaker and usage reporting directly.

Tests moved to mirror the new source layout, one test file's path following its source file's path. `tests/unit/vernLLM.utils.unit.test.ts` was split into `retry.utils.unit.test.ts`, `errors.utils.unit.test.ts`, and `usage.utils.unit.test.ts`, matching the source split. A new `streamAccumulator.unit.test.ts` exercises the accumulator directly against a hand built chunk iterator, instead of only reaching it through a full `VernLLM` instance and a mock client.

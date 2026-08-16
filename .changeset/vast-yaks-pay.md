---
'vern-llm': minor
---

Added manual circuit-breaker control: `VernLLM.openCircuit(target?)` and `VernLLM.closeCircuit(target?)` let a caller force a target's breaker open or closed (e.g. to pull a provider out of rotation ahead of known maintenance, or to skip the cooldown once a provider is confirmed healthy again), without waiting for real traffic to trip it. Both take an optional `{ index?, model? }`, defaulting to the primary target's shared circuit.

`getCircuitState` now takes the same `{ index?, model? }` shape instead of a bare `model` string, so it can address fallback targets too, not just the primary. This is a breaking change to an already-shipped signature: `llm.getCircuitState('gpt-4o')` becomes `llm.getCircuitState({ model: 'gpt-4o' })`. Being accepted on minor since `vern-llm` is still in beta and `getCircuitState` was itself a fairly recent addition.

An out-of-range `index` on `getCircuitState`/`openCircuit`/`closeCircuit` now throws `RangeError`, so it stays distinguishable from a real target that simply has no breaker configured (which still returns/no-ops normally). Passing `model` to a target whose breaker doesn't have `circuitBreaker.isolateByModel` on now logs a warning instead of silently doing nothing, since the shared-bucket state or action is used regardless.

When `model` is omitted on `getCircuitState`/`openCircuit`/`closeCircuit`/`getCircuitStates`, it now defaults to that target's own configured model instead of the unlabeled bucket, matching the bucket real call failures/successes are recorded under for a target with `isolateByModel` on. An explicit `model` argument is unaffected.

`getCircuitStates()` entries now include `isolateByModel`, so a caller sweeping `model` across a fallback chain with mixed per-target configs can tell which entries actually honored it.

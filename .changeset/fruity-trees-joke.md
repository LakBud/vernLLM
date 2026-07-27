---
'vern-llm': patch
---

Fix circuit breaker allowing multiple concurrent trial calls during half-open.

`assertClosed()` transitioned the circuit to `half-open` once the cooldown elapsed, but every
concurrent caller after that point was also let through unblocked, since the guard only checked
for `state === 'open'`. This meant several "trial" calls could hit the provider at once right when
the cooldown ended, instead of the intended single trial.

Added a `trialInFlight` flag: only the first caller during half-open becomes the trial and reaches
the provider; every other concurrent caller is rejected immediately with `circuit_open` until the
trial's outcome is recorded via `recordSuccess`/`recordFailure`.

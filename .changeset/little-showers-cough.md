---
'vern-llm': minor
---

Add `halfOpenProbes` and `halfOpenSuccessRatio` to `CircuitBreakerOptions`, letting a half-open
circuit admit more than one trial call before deciding to close or reopen.

Today, exactly one trial call is let through once cooldown elapses: a single success closes the
circuit, a single failure reopens it. That is a noisy signal for a provider whose failures are
intermittent rather than total, one lucky or unlucky call decides the outcome. `halfOpenProbes`
lets several trials run, and `halfOpenSuccessRatio` decides how many of them need to succeed:

```ts
const llm = new VernLLM({
  client: fromOpenAI(openai),
  model: 'gpt-4o',
  circuitBreaker: {
    threshold: 5,
    cooldownMs: 30_000,
    halfOpenProbes: 3,
    halfOpenSuccessRatio: 0.67, // 2 of 3 trials succeeding closes the circuit
  },
});
```

`halfOpenProbes` defaults to 1 and `halfOpenSuccessRatio` defaults to 1, exactly reproducing
today's single trial, must succeed behavior when both are left unset. Both are clamped at
construction (`halfOpenProbes` to at least 1, `halfOpenSuccessRatio` to `[0, 1]`) rather than
thrown, since a bad value here shouldn't take down the call path.

A concurrent caller beyond the configured number of probes is still rejected with
`circuit_trial_in_flight`, same as today.

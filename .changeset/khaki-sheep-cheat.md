---
'vern-llm': minor
---

Add `cooldownBackoff` to `CircuitBreakerOptions`, growing the cooldown on each repeat open instead
of using the same fixed wait every time.

Today, `cooldownMs` is a fixed value applied identically every time the circuit opens. A provider
that keeps failing every cooldown period cycles through the same fixed wait forever. `cooldownBackoff`
lets that wait grow the more times the circuit reopens:

```ts
const llm = new VernLLM({
  client: fromOpenAI(openai),
  model: 'gpt-4o',
  circuitBreaker: {
    threshold: 5,
    cooldownMs: 30_000,
    cooldownBackoff: { multiplier: 2, maxMs: 5 * 60_000 },
  },
});
```

`{ multiplier, maxMs }` is shorthand for exponential growth, the shape most callers reach for. A
`CooldownBackoff` function, `(reopenCount, baseCooldownMs) => number`, is the escape hatch for
anything else, jitter or a linear ramp. `reopenCount` only increments on a trial that failed back
to open, not on the first open from closed.

Omitted (the default), `cooldownMs` stays fixed, exactly reproducing today's behavior.

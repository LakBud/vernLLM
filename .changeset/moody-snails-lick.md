---
'vern-llm': minor
---

Add AIMD (additive increase / multiplicative decrease) to `RateLimiter`, letting a target's
requests-per-minute ceiling grow gradually on success and shrink on a real rate limit rather than
staying fixed:

```ts
const llm = new VernLLM({
  client: fromOpenAI(openai),
  model: 'gpt-4o',
  rateLimit: {
    requestsPerMinute: 500,
    aimd: { increaseBy: 10, decreaseFactor: 0.5, minCapacity: 50, maxCapacity: 1000 },
  },
});
```

`increaseBy` is added to the ceiling on every clean release; `decreaseFactor` multiplies it down
whenever the limiter reacts to a rate limit, bounded to `[minCapacity, maxCapacity]`. Reacting to
a real 429 works for every provider unconditionally, no adapter changes required.

`fromOpenAI` and `fromAnthropic` can additionally react proactively, before a real 429 happens, by
reading a provider's own rate limit headers off a successful response. This needs an explicit
opt-in, since it depends on the underlying client supporting `.withResponse()`:

```ts
const llm = new VernLLM({
  client: fromOpenAI(openai, { supportsWithResponse: true }),
  model: 'gpt-4o',
  rateLimit: {
    requestsPerMinute: 500,
    aimd: {
      increaseBy: 10,
      decreaseFactor: 0.5,
      minCapacity: 50,
      maxCapacity: 1000,
      proactiveFloor: 20,
    },
  },
});
```

With `proactiveFloor` set, the limiter shrinks as soon as a response reports remaining capacity at
or below that number, rather than waiting for an actual rejection. `fromFetch` gets the same
proactive path with no opt-in needed (a new `parseRateLimitHint` config option, defaulting to
OpenAI's header shape), since it already has direct access to the response headers. `fromGemini`
and `fromBedrock` get reactive-only AIMD: neither provider exposes a remaining-capacity header to
react to proactively, confirmed against their own current documentation and SDK source, so only
the real-429 path applies there.

`TokenBucket.resize()` is new internal plumbing this relies on: a bucket's capacity can now change
after construction, with its refill rate rescaled proportionally so a shrink doesn't leave the
bucket refilling at its old, relatively-too-fast rate.

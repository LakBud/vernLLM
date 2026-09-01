---
'vern-llm': minor
---

Add `RateLimiterAdapter`, a pluggable extension point so `rateLimit` can be backed by a limiter
that coordinates across processes, not just the built in in-process `RateLimiter`.

Today, `rateLimit` on `VernLLMOptions` and `FallbackTarget` always builds a fresh in-process
`RateLimiter`. A second VernLLM instance, a second server process, or a horizontally scaled
deployment each get their own independent bucket, so the real ceiling a provider enforces is
never actually shared across any of them, and there was no way to plug in a limiter that is.

```ts
import { VernLLM, type RateLimiterAdapter } from 'vern-llm';

const sharedLimiter: RateLimiterAdapter = new MyRedisBackedRateLimiter(/* ... */);

const llm = new VernLLM({
  client: fromOpenAI(openai),
  model: 'gpt-4o',
  rateLimit: sharedLimiter,
});
```

`RateLimiterAdapter` is the same surface `RateLimiter` already exposes: `estimate`, `acquire`,
`signalRateLimit`, `reactToRateLimitHint`. Handing over an object satisfying it, instead of a
plain `RateLimitOptions` config, is used as is, no wrapping. The same instance can be shared
across the primary and any fallback target on purpose, e.g. two targets that really do draw on
one provider account's real ceiling.

Passing a plain `RateLimitOptions` object (today's only option) keeps building an in-process
`RateLimiter` exactly as before, zero behavioral change.

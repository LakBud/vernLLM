---
'vern-llm': minor
---

Add a handful of small, additive improvements to the call framework and caching:

- **`estimateFraction` on `RateLimitOptions`.** The default `estimateTokens` reserves the full `max_tokens` against the `tokensPerMinute` bucket before a response lands, since real usage isn't known yet. Most calls don't use their whole `max_tokens` budget, so a full-estimate reservation under-throttles real throughput. `estimateFraction` (default `1`, today's behavior) scales the pre-flight estimate down before it's reserved; `release`'s `actualTokens` still reconciles the bucket against real usage afterward, the same as always. This only affects the rate limiter's own bookkeeping, never the `max_tokens` sent to the provider, which remains an untouched, caller-set safety ceiling.

- **`deadlineAt` on `CallParams`.** An absolute alternative to `deadlineMs` for budgeting a whole sequence of calls against one shared deadline:

```ts
const deadlineAt = Date.now() + 10_000;
await llm.call({ userContent: '...', deadlineAt });
await llm.call({ userContent: '...', deadlineAt, history });
```

Three calls, one 10-second budget, instead of each call re-granting itself a fresh `deadlineMs`. Set at most one of `deadlineMs`/`deadlineAt`.

- **A `'usage'` `onEvent` kind.** `onEvent` already reports retries, fallovers, circuit transitions, rate-limit waits, and middleware hooks, but not usage, the thing most people actually want to aggregate. `{ kind: 'usage', requestId, provider, model, usage }` now fires alongside the existing `onUsage` hook on every successful call, closing an observability gap that existed independently of `onUsage` itself (previously, usage was only visible through a dedicated hook, not through the general event stream).

- **`VernLLM.prototype.deriveCacheKey(params)`.** Derives a `cachedCall({ cacheKey })` value from `params` itself by hashing the exact wire request the primary target would build (prompt, resolved model, resolved temperature, `max_tokens`, tools, and everything else that actually reaches the provider, after instance defaults are applied). Closes the gap a hand-picked `cacheKey` leaves open: change the prompt, a per-call `model` override, or `temperature` without also updating a hand-picked key, and `cachedCall` previously had no way to notice and would silently serve stale output.

- **`preserveChars` option on `NormalizedCacheAdapter`, plus documented the collision risk it addresses.** The default normalization collapses every kind of punctuation into an identical space, which is the point for surface-formatting differences (`"2+2?"` vs `"2+2"`) but means two genuinely different values that differ only in _which_ separator character they use (`"order A-1"` vs `"order A:1"`) can silently share a cache entry. There's no way to fix this generically, the same transformation produces both the desired collapse and the accidental collision, so instead `new NormalizedCacheAdapter(inner, { preserveChars: ':-' })` lets a caller keep specific, known-meaningful separator characters literal instead of stripped, fixing the collision for their domain without writing a full custom `resolveKey`. Default behavior (no `preserveChars`) is unchanged. Added a warning to the class's JSDoc, a new "Collision risk" section (with the `preserveChars` fix) in the Normalized Caching guide, and tests covering both the documented collision and the fix.

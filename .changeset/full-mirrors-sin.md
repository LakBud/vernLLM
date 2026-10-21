---
'vern-llm': minor
---

Add `TokenUsage.costUsd`, the cost the provider says a call had, in USD.

It is filled from OpenRouter's `usage.cost` by the OpenAI compatible adapter, for plain and streamed calls, and from the `costUsd` a `fromFetch` `mapResponse` returns. It stays out of the usage when the response has no cost, or a negative or non finite one.

```ts
onUsage: ({ costUsd, totalTokens }) => billing.record({ costUsd, totalTokens }),
```

Nothing existing changes: the field is optional and no adapter reports it unless the provider sends one.

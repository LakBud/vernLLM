---
'vern-llm': minor
---

`fromAnthropic` no longer drops `reasoning_effort`. Anthropic has no tiered reasoning concept of
its own, extended thinking is controlled by a `budget_tokens` value, not a string like OpenAI's
`'minimal' | 'low' | 'medium' | 'high'`, so this was previously a documented, silent no-op on this
adapter. It's now mapped onto `thinking: { type: 'enabled', budget_tokens }`:

- `'low'` → 1024, `'medium'` → 4096, `'high'` → 16000 tokens.
- `'minimal'` (and an unset `reasoning_effort`) leaves thinking disabled, matching prior behavior.
- Anthropic requires `temperature` to be unset or exactly `1` whenever thinking is enabled, so
  `fromAnthropic` now drops any caller-supplied `temperature` for a call where thinking ends up
  enabled, rather than sending a value the API would reject.
- `max_tokens` must be strictly greater than the mapped budget, since some of it has to be left
  for the actual response on top of the thinking spend. A call that doesn't leave that room throws
  `LLMError('invalid_params')` naming the budget, instead of silently truncating or guessing a
  larger `max_tokens`.

The three default budgets can be overridden per client via `fromAnthropic`'s existing options
argument:

```ts
fromAnthropic(anthropicClient, {
  reasoningEffortBudgets: { high: 32000 },
});
```

Only the tiers you pass are overridden; any left unset keep the adapter's default. This lives on
the adapter rather than on `CallParams` because `reasoning_effort` is the one reasoning knob
shared across every provider's call params: a `fromFallback` chain sends the same params to every
target, so a budget tied to one call's params can't vary by which provider actually serves it, but
each adapter instance can interpret the same tier however fits its own API.

This is purely additive: no existing call or option changes behavior unless `reasoning_effort` was
already being passed to a `fromAnthropic` client, in which case it now does something instead of
being silently ignored.

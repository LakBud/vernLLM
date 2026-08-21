---
'vern-llm': minor
---

Added `budgetTokens` on `CallParams`, a numeric reasoning budget alongside the existing
`reasoningEffort` tier string.

Each adapter reads its own native field first. Anthropic and Gemini use `budgetTokens` directly.
OpenAI compatible clients use `reasoningEffort` directly. Bedrock forwards a budget only for Claude
models. When only the other field is set, it is converted through a shared table, documented in
`adapters/internal/reasoningBudget.utils.ts`.

Also added `reasoningTokens` on `TokenUsage`, a subset of `completionTokens`, populated whenever
the provider reports a separate figure for internal reasoning. Undefined for Bedrock today, since
Converse only returns that figure if the request explicitly asks for it, a separate feature outside
this change.

Neither field is required. Existing calls that set nothing here are unaffected.

See the `budgetTokens` row in the
[Call Params reference](https://vernllm.vercel.app/docs/API-reference/call-params) for full per
provider behavior.

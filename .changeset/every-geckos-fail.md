---
'vern-llm': minor
---

Added `onUsageFailure`, an opt-in hook that reports token usage for calls that spent real tokens but then failed on VernLLM's own post-response handling, such as parse or schema validation errors, instead of silently dropping that spend.

`onUsage` only fires on full success, so there was previously no way to know a failed call had still cost tokens. `onUsageFailure` fills that gap: it fires once per failed attempt when the provider response included usage data, receiving the same `TokenUsage` shape as `onUsage` plus the `LLMError` that caused the failure. It covers any error thrown after a response arrives, not just parse/validation, and is skipped for transport failures (timeout, network error, non-retryable status) and for calls that were aborted, since in both cases there is no usage to report or the error type would not match what `call()` ultimately throws.

This is purely additive. `onUsage`'s existing contract is unchanged, and no action is needed for existing integrations.

See the [Usage Tracking](https://vernllm.vercel.app/docs/core/usage-tracking) docs for the full shape and firing semantics.

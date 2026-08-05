---
'vern-llm': minor
---

Added a way to opt out of VernLLM's `temperature: 0.2` default and let the provider apply its own default instead.

Pass `temperature: null` on a call, or `defaultTemperature: null` on the `VernLLM` instance, and `temperature` is omitted from the request entirely rather than sent as `0.2`. A per-call `temperature` still wins over the instance-level `defaultTemperature`, which still wins over the `0.2` fallback, same resolution order as `maxTokens`/`defaultMaxTokens`.

This is purely additive for normal `call()` usage. Omitting `temperature` everywhere keeps sending `0.2` exactly as before, no behavior changes for existing callers.

One narrow caveat: making this work required widening `LLMClient`'s wire-level `temperature: number` to `temperature?: number`. This only affects hand-written `LLMClient` implementations that assume `params.temperature` is always a `number` without checking whether it's `undefined`, every built-in adapter (`fromAnthropic`, `fromBedrock`, `fromGemini`, `fromFetch`, OpenAI-compatible) is unaffected. See Migration Notes for details.

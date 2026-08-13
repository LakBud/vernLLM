---
'vern-llm': minor
---

Added `VernLLMOptions.redact`, applied to model output before it reaches the debug logger.

`debug: true` logs up to 800 characters of raw model output on success, and the provider's original error on failure, including a stream-open failure. Until now there was no way to scrub that output before it hit the logger, an accidental spot for prompt content or PII to end up in logs. `redact` closes that gap:

```ts
const llm = new VernLLM({
  client: openai,
  model: 'gpt-4o',
  debug: true,
  redact: (text) => text.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED]'),
});
```

Applied to every internal debug log line, the success output, a failed `call()`, and a failed stream open, the one place an app has no other way to intercept, since these are direct `logger.debug` calls rather than something routed through a callback. `onEvent` payloads, `LLMError.cause`, and `onUsageFailure` already hand raw content straight to app-owned callbacks, so redacting those needs no help from `VernLLM`; only the debug log required a new option.

`redact` runs before every internal `logger.debug()` call regardless of whether that call ends up emitting anything. With the default console logger, `debug: false` (the default) means nothing is logged, so `redact` has no visible effect. With a custom `logger`, `VernLLM` doesn't check `debug` at all before calling into it, that logger's own `debug()` decides whether to emit, so `redact` runs and can have a visible effect even without `debug: true`.

Additive and optional. Omitting `redact` is a no-op, identical to today's behavior.

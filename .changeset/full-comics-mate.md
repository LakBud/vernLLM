---
'vern-llm': minor
---

Added `VernLLMOptions.redact`, applied to model output before it reaches the debug logger.

`debug: true` logs up to 800 characters of raw model output on success, and the provider's original error on failure. Until now there was no way to scrub that output before it hit the logger, an accidental spot for prompt content or PII to end up in logs. `redact` closes that gap:

```ts
const llm = new VernLLM({
  client: openai,
  model: 'gpt-4o',
  debug: true,
  redact: (text) => text.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED]'),
});
```

Scoped specifically to the internal debug log line, the one place an app has no other way to intercept, since it's a direct `logger.debug` call rather than something routed through a callback. `onEvent` payloads, `LLMError.cause`, and `onUsageFailure` already hand raw content straight to app-owned callbacks, so redacting those needs no help from `VernLLM`; only the debug log required a new option. Has no effect unless `debug: true` is also set, since nothing is logged to redact otherwise.

Additive and optional. Omitting `redact` is a no-op, identical to today's behavior.

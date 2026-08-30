---
'vern-llm': minor
---

Add `detectSoftFailure`, a hook that can reclassify a technically successful response as a
failure.

A response can parse cleanly and pass schema validation without actually being a good answer: a
placeholder string, an empty-but-present response, or a low-confidence refusal all look like
successes to retries and the circuit breaker today. `detectSoftFailure` runs once per attempt,
right after a response is shaped, and lets you turn that result into a real failure before it
reaches the caller:

```ts
const llm = new VernLLM({
  client: fromOpenAI(openai),
  model: 'gpt-4o',
  detectSoftFailure: (result, meta) => {
    if (typeof result === 'string' && result.trim() === 'N/A') {
      return 'empty_response';
    }
    return undefined;
  },
});
```

Returning `undefined` leaves the result as a success. Returning an `LLMErrorCode` fails the
attempt with that code, feeding the same retry and circuit breaker paths a thrown error would. A
throwing hook is caught, logged, and treated as no soft failure. `fallback` targets accept their
own `detectSoftFailure`, inheriting the parent instance's hook when left unset.

For streaming calls, a soft failure rejects `finalResult` the same as any other post-stream
failure, but does not count toward the circuit breaker: by the time the final result is shaped,
the streaming attempt has already returned successfully from the retry loop.

Adds `soft_failure_detected` as a new `LLMErrorCode`. See the
[Error Handling](/docs/core/error-handling#soft-failure-detection) docs for details.

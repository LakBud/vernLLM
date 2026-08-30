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
      return 'soft_failure_detected';
    }
    return undefined;
  },
});
```

Returning `undefined` leaves the result as a success. Returning an `LLMErrorCode` fails the
attempt with that code, feeding the same retry and circuit breaker paths a thrown error would. A
throwing hook is caught, logged, and treated as no soft failure. `fallback` targets accept their
own `detectSoftFailure`, inheriting the parent instance's hook when left unset.

A soft failure on a streaming call rejects `finalResult` and counts toward the circuit breaker,
same as a non-streaming failure would, even though the streaming attempt has already returned
successfully from VernLLM's own retry loop by that point.

Adds `soft_failure_detected` as a new `LLMErrorCode`. See the
[Error Handling](/docs/core/error-handling#soft-failure-detection) docs for details.

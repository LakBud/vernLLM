---
'vern-llm': minor
---

Every recorded `RetryAttempt` now also carries `request`, a snapshot of what was actually sent for
that attempt, sitting next to the existing `error` snapshot of what came back:

```ts
try {
  await llm.call({ userContent: 'Hello' });
} catch (err) {
  if (isLLMError(err)) {
    for (const attempt of err.attempts ?? []) {
      console.log(attempt.error.message, attempt.request?.body);
    }
  }
}
```

`request` is an `LLMRequestSnapshot`:

```ts
interface LLMRequestSnapshot {
  provider: string;
  model: string;
  body: unknown;
  headers?: Record<string, string>;
  startedAt: number;
}
```

Auth headers (`Authorization`, `x-api-key`, `x-goog-api-key`, `api-key`) are always stripped
before the snapshot is built, case insensitively, so they never end up in `headers`.

`request` is optional and additive. It is `undefined` on attempts recorded before this field
existed, and `FallbackAttempt` picks it up for free since it already extends `RetryAttempt`. No
existing field, method, or constructor option changes shape.

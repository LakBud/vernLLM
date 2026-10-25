---
'vern-llm': minor
---

`LLMErrorCode` gains `content_blocked` (type `invalid_params`), for a middleware that refuses a call, or the answer it got, because of its content. It is told apart from provider faults, budgets and policy in logs and `catch` blocks. Like any `invalid_params` error it is not retried, stops fallback and never counts toward the circuit breaker. The core does not throw it itself.

A `wrap` can now refuse a result it has seen. An `LLMError` with code `content_blocked` thrown after `next()` resolved is rethrown to the caller. Every other throw after `next()` is still logged and swallowed, so a bug in post processing can't fail a billed call.

```ts
const refuseEmpty: VernLLMMiddleware = {
  name: 'refuse-empty',
  wrap: async (request, next) => {
    const result = await next();
    if (result.value === '') {
      throw new LLMError(
        'Call blocked: content refused by middleware "refuse-empty"',
        'invalid_params',
        {
          code: 'content_blocked',
        },
      );
    }
    return result;
  },
};
```

A new member on an exported union can break an exhaustive `switch` over `LLMErrorCode`, which then needs the new case.

---
'vern-llm': minor
---

`LLMError` now defines `toJSON()`, and `LLMErrorSnapshot` (the shape of `RetryAttempt.error`) no longer has a `cause` field. Both changes have the same reason: `cause` is `unknown` and never validated by VernLLM, so it's the one field on `LLMError` that isn't guaranteed safe to hand to `JSON.stringify`. Some SDKs throw errors with circular internal references, which `JSON.stringify` cannot serialize. Rather than deriving a "safe" summary of an arbitrary, unvalidated value, `cause` is simply left out. `JSON.stringify(err)` and `err.toSnapshot()`/`err.attempts[i].error` now serialize `type`, `code`, `status`, `issues`, and `retryable`, and nothing else. `err.cause` on the live, just-caught error is unaffected and still holds the exact original value. That's where `cause` is meant to be read, on the spot, not folded into serialization or carried inside retry history.

As a side effect, `JSON.stringify(err)` now also includes `message` and `retryable`, which a plain property walk previously missed. `message` is non-enumerable on `Error`, and `retryable` is a getter, not an own property.

`issues` is included in both, but not unconditionally: for a schema validation failure, `issues` is a caller supplied `SchemaLike` validator's own `error: unknown`, not controlled by VernLLM and not guaranteed circular free. A circular `issues` value is replaced with an explicit marker string in the serialized output, rather than dropped silently. `err.issues` on the live error is unaffected.

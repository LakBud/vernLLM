---
'vern-llm': minor
---

`LLMError` now defines `toJSON()`, controlling what `JSON.stringify(err)` produces:
`name`, `message`, `type`, `status`, `issues`, `retryAfterMs`, `code`, `retryable`, `attempts`.
`LLMErrorSnapshot` (the shape of `RetryAttempt.error`, also what `toSnapshot()` returns) carries
the same fields except `name`: `message`, `type`, `status`, `issues`, `retryAfterMs`, `code`,
`retryable`, `attempts`.

`cause` is left out of both, deliberately. `cause` is `unknown` and never validated by VernLLM, so
it is the one field on `LLMError` that is not guaranteed safe to hand to `JSON.stringify`: some
SDKs throw errors with circular internal references, which `JSON.stringify` cannot serialize.
`err.cause` on the live, just-caught error is unaffected and still holds the exact original value.
That is where `cause` is meant to be read, on the spot, not folded into serialization or carried
inside retry history.

`message` and `retryable` are included even though a plain property walk would miss both:
`message` is non-enumerable on `Error`, and `retryable` is a getter, not an own property.

`issues` is included, but not unconditionally. For a schema validation failure, `issues` is a
caller supplied `SchemaLike` validator's own `error: unknown`, not controlled by VernLLM and not
guaranteed circular free. A circular `issues` value is replaced with an explicit marker string in
the serialized output, rather than dropped silently or left to throw. `err.issues` on the live
error is unaffected. This check runs recursively through every nested `attempts` entry's own
`issues` too, not just the top level `issues`, since `attempts` is itself a public constructor
option a caller can hand build, and a previously safe `issues` reference on a snapshot can be
mutated into a circular one later.

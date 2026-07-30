---
'vern-llm': minor
---

`LLMError` now preserves the original error thrown by the provider client, instead of discarding it once the status code has been extracted.

**Changes:**

- **`LLMError`**: added two new optional fields, `cause` and `retryAfterMs`. `cause` carries the raw
  value thrown by the underlying client (the actual SDK/HTTP error), so consumers can inspect the
  provider's real rejection reason (message, response body, etc) even though the top-level
  `LLMError` message stays a generic `'LLM request failed'`. `retryAfterMs` carries the parsed
  `Retry-After` value (if any) from the last failed attempt, using the same delta-seconds/HTTP-date
  parsing and cap already used internally for backoff.

- **`normalizeError`**: now attaches both fields when building the final thrown `LLMError` for
  `'api'` and `'unknown'` error types. Existing consumers checking `.type`/`.status`/`.issues` are
  unaffected — this is purely additive.

- **`debug` logging**: previously `logger.debug` only fired on a successful response. It now also
  fires on the failure path via a new `describeError()` helper, logging the provider's actual
  rejection reason (`.error` or `.message`) before the normalized `LLMError` is thrown. This makes
  `debug: true` useful for diagnosing failed calls, not just inspecting successful output.

- **Tests**: added coverage in `vernLLM.call.unit.test.ts` for `.cause` being preserved on both
  `'api'` and `'unknown'` errors, and for `.retryAfterMs` being surfaced on the final thrown error.

- **Docs**: updated `core/error-handling.mdx` (new `.cause`/`.retryAfterMs` fields, corrected the
  now-outdated callout claiming the raw error wasn't preserved, added a "Debugging a failed call"
  section) and `core/logging.mdx`/`API-reference/configuration.mdx` (`debug` now also covers the
  failure path; also fixed an unrelated pre-existing docs bug incorrectly stating `debug` defaults
  to `NODE_ENV !== 'production'` when the actual default is `false`).

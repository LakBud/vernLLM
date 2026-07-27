---
'vern-llm': minor
---

Honor a `Retry-After` header on retryable failures instead of always using exponential backoff.

**Changes:**

- **Core**: Added `extractRetryAfterMs()` in `internal/vernLLM.utils.ts`, which reads `.headers`
  (fetch-style) or `.response.headers` (axios-style) off a thrown error and parses `Retry-After` in
  either delta-seconds (`"30"`) or HTTP-date form. `getBackoffDelay`'s previously-inline `10_000`
  default is now the shared `DEFAULT_MAX_DELAY_MS` constant, also used to cap the honored
  `Retry-After` value so a misbehaving/adversarial header can't stall a caller indefinitely.

- **`recoverDelay`**: now uses `extractRetryAfterMs(error) ?? getBackoffDelay(...)`, falling back to
  today's exponential-backoff-with-jitter exactly as before when no usable header is present. No
  adapter changes needed — headers already flow through on thrown errors (fetch adapter via the
  prior `request`/headers PR, SDK-based adapters natively).

- **Tests**: added `tests/unit/vernLLM.utils.unit.test.ts` for `extractRetryAfterMs` (delta-seconds,
  HTTP-date, axios vs Headers-like shapes, capping, past-date clamping, missing/unparseable header),
  plus end-to-end retry tests in `vernLLM.call.unit.test.ts` (honors Retry-After over a larger
  configured backoff, caps an oversized Retry-After, falls back to backoff when absent).

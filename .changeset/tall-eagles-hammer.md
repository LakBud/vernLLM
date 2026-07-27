---
'vern-llm': minor
---

Fix default behaviors that didn't match the library's intended resilience/logging guarantees.

- **`nonRetryableStatus`**: default extended from `[400, 401, 403]` to `[400, 401, 403, 404, 422]`.
  404/422 can never succeed on retry, so retrying them was always wasted.
- **Debug logging**: no longer defaults to on when `NODE_ENV !== 'production'`. Now defaults to
  `false`, since debug logging can output raw response content and many environments never set
  `NODE_ENV` explicitly. Opt in via `debug: true`.
  - **Unit tests**: added for the debug logger
- Docs updated to match (`error-handling.mdx`, `logger.mdx`).

Minor bump: changes default behavior for existing consumers, but explicit `debug`/
`nonRetryableStatus` settings are unaffected.

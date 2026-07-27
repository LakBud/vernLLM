---
'vern-llm': minor
---

Improve the `fetch.ts` adapter: allow an injectable `request` function (defaults to native
`fetch`) typed against a `ResponseLike` interface for interop with axios/node-fetch/etc, skip
`body`/`Content-Type` for GET/HEAD requests, and attach `res.headers` to thrown errors so
downstream retry logic can read `Retry-After`.

Minor bump: fully additive, no changes to existing `fromFetch` call signatures or behavior for
POST/PUT/PATCH.

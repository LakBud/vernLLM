# vern-llm

## 1.5.0

### Minor Changes

- 20591dc: `LLMError` now preserves the original error thrown by the provider client, instead of discarding it once the status code has been extracted.

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

### Patch Changes

- 8dbd711: Throw `LLMError('validation')` when `schema` is combined with `jsonMode: false` (without `jsonSchema`), instead of silently skipping validation and returning an unvalidated string cast to the schema's type.
- 4d0366f: update install section on readme

## 1.4.0

### Minor Changes

- 95b1a36: Coalesce concurrent `cachedCall` misses for the same `cacheKey` into a single `fn()` call.

  Previously, every concurrent request for the same `cacheKey` that missed the cache independently
  called `fn()`, causing a cache stampede: N simultaneous callers could trigger N calls to the
  underlying (possibly expensive) LLM call before any of them had a chance to populate the cache.

  Now only the first caller (the "trigger") calls `fn()`; every other concurrent caller for the same
  key waits on that same in-flight call and shares its result or failure.

  `reserveUsage`/`refundUsage` now receive a `{ coalesced: boolean }` argument, so applications can
  decide how coalesced callers are billed: full price, a reduced rate, or not billed at all. This is
  backward compatible — existing `() => Promise<void>` implementations don't need to change.

  Docs updated in `core/caching.mdx` to describe the coalescing behavior and the new `coalesced` flag.

- 480e0c6: Honor a `Retry-After` header on retryable failures instead of always using exponential backoff.

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

- eca6cf2: Improve the `fetch.ts` adapter: allow an injectable `request` function (defaults to native
  `fetch`) typed against a `ResponseLike` interface for interop with axios/node-fetch/etc, skip
  `body`/`Content-Type` for GET/HEAD requests, and attach `res.headers` to thrown errors so
  downstream retry logic can read `Retry-After`.

  Minor bump: fully additive, no changes to existing `fromFetch` call signatures or behavior for
  POST/PUT/PATCH.

- 06c5297: Add multimodal input support through `userContent`.

  `userContent` now accepts either a plain string or a `ContentBlock[]` array containing text and image
  blocks. Existing string-based calls continue to work unchanged.

  Image blocks are translated automatically by provider adapters:

  - OpenAI-compatible providers pass through native multimodal content.
  - Anthropic converts image blocks to image source blocks.
  - Gemini converts image blocks to inline data parts.
  - AWS Bedrock converts image blocks to Converse image content blocks.

  This enables sending images alongside text while keeping the existing text-only API backwards
  compatible.

### Patch Changes

- 1ed6246: Fix circuit breaker allowing multiple concurrent trial calls during half-open.

  `assertClosed()` transitioned the circuit to `half-open` once the cooldown elapsed, but every
  concurrent caller after that point was also let through unblocked, since the guard only checked
  for `state === 'open'`. This meant several "trial" calls could hit the provider at once right when
  the cooldown ended, instead of the intended single trial.

  Added a `trialInFlight` flag: only the first caller during half-open becomes the trial and reaches
  the provider; every other concurrent caller is rejected immediately with `circuit_open` until the
  trial's outcome is recorded via `recordSuccess`/`recordFailure`.

## 1.3.0

### Minor Changes

- f1c238f: Fix default behaviors that didn't match the library's intended resilience/logging guarantees.

  - **`nonRetryableStatus`**: default extended from `[400, 401, 403]` to `[400, 401, 403, 404, 422]`.
    404/422 can never succeed on retry, so retrying them was always wasted.
  - **Debug logging**: no longer defaults to on when `NODE_ENV !== 'production'`. Now defaults to
    `false`, since debug logging can output raw response content and many environments never set
    `NODE_ENV` explicitly. Opt in via `debug: true`.
    - **Unit tests**: added for the debug logger
  - Docs updated to match (`error-handling.mdx`, `logger.mdx`).

  Minor bump: changes default behavior for existing consumers, but explicit `debug`/
  `nonRetryableStatus` settings are unaffected.

## 1.2.0

### Minor Changes

- 690f7f3: Add named adapter aliases for additional OpenAI-compatible LLM providers.

  **Changes:**

  - **Source**: Added new provider aliases for additional OpenAI-compatible providers, all backed by `fromOpenAICompatible` with zero request/response transformation.
  - **Adapters**: Added support for providers including xAI, NVIDIA NIM, Vercel AI Gateway, Cloudflare Workers AI, GitHub Models, Nebius, SambaNova, Baseten, DashScope, Featherless, Friendli, SiliconFlow, LiteLLM Proxy, Parasail, StepFun, MiniMax, Lambda Labs, Snowflake Cortex, Anyscale, Lepton, kluster.ai, Inference.net, Infermatic, AtlasCloud, and 01.AI.
  - **Docs**: Expanded `openai-compatible` documentation with the full list of supported named adapters and clarified `fromOpenAICompatible()` as the generic fallback.
  - **Homepage**: Updated the provider list with the newly supported providers.
  - **Changeset**: Minor bump for `vern-llm` — purely additive, no breaking changes.

## 1.1.0

### Minor Changes

- b46d6f7: Added named adapter aliases for 9 more OpenAI-compatible LLM providers to `vern-llm`: OpenRouter, Perplexity, DeepInfra, Novita, Hyperbolic, Moonshot, Zhipu, LM Studio, and vLLM.

  **Changes:**

  - **Source**: `fromOpenRouter`, `fromPerplexity`, `fromDeepInfra`, `fromNovita`, `fromHyperbolic`, `fromMoonshot`, `fromZhipu`, `fromLMStudio`, `fromVLLM` added as aliases for `fromOpenAICompatible` in `packages/vern-llm/src/adapters/openaiCompatible.ts`, re-exported via `adapters/index.ts` and `src/index.ts`
  - **Tests**: added to the parameterized alias check in `openaiCompatible.unit.test.ts` (18/18 passing)
  - **Docs**: `adapters/index.mdx` and `adapters/openai-compatible.mdx` updated to list all providers as named wrappers
  - **Homepage**: `home.utils.ts` `providers` array expanded with icons + doc links for all new providers (fixed `Vllm` casing to match actual `@lobehub/icons` export)
  - **Changeset**: minor bump for `vern-llm` — purely additive, no breaking changes

  **Verified**: `tsc --noEmit` clean on both the package and docs app, `dist/` rebuilt via `tsdown` to include new exports, `changeset status` confirms minor bump.

## 1.0.0

### Major Changes

- 96a29f4: **Breaking: `CacheAdapter.get()` now returns `Promise<{ hit: boolean; value: T | null }>` instead of `Promise<T | null>`.**

  This lets `cachedCall`/`cachedLLMCall` correctly distinguish a cache miss from a legitimately cached `null` value, so a valid `null` result is now reused from cache instead of being treated as a miss and re-triggering an LLM call.

  `InMemoryCacheAdapter` (the built-in default) is updated automatically — no action needed if you're using it. If you've implemented a custom `CacheAdapter` (Redis, Upstash, or otherwise), you'll need to update its `get()` method. See the migration guide below.

  Also in this release:

  Make `CallParams.systemPrompt` optional and omit system messages when unset.
  Export `AnthropicClient`, `GeminiClient`, and `BedrockConverseClient` as public types.
  Add an `adapters` barrel export for provider adapters.
  Refactor internal types into focused modules.
  Add regression and integration test coverage for optional system prompts and adapter behavior.
  Add Anthropic adapter coverage to verify provider payloads omit `system` when `systemPrompt` is not provided.
  Add cache adapter test coverage for custom adapter support, cache size bounds, and cache failure handling.
  Add in-memory cache size limiting to prevent unbounded growth.
  Bump the major version to reflect the breaking `CacheAdapter.get()` change.

  ## Migration guide

  ### `CacheAdapter.get()`

  **Before:**

  ```ts
  class MyCacheAdapter implements CacheAdapter<MyValue> {
    async get(key: string): Promise<MyValue | null> {
      const raw = await redis.get(key);
      return raw ? JSON.parse(raw) : null;
    }
    // ...
  }
  ```

  **After:**

  ```ts
  class MyCacheAdapter implements CacheAdapter<MyValue> {
    async get(key: string): Promise<{ hit: boolean; value: MyValue | null }> {
      const raw = await redis.get(key);

      if (raw === null) {
        return { hit: false, value: null };
      }

      return { hit: true, value: JSON.parse(raw) };
    }
    // ...
  }
  ```

  The key change: `hit` should be `true` whenever the key existed in the underlying store (even if the stored value itself is `null`), and `false` only when nothing was found. Most adapters can derive this directly from whatever "does this key exist" signal their underlying store already gives them (e.g. Redis returning `null` vs. a real value, or an `EXISTS` check).

  If you don't want to implement the distinction and are fine with `null` results simply never being served from cache, you can also just return `{ hit: value !== null, value }` from your existing `get()` logic as a drop-in shim.

## 0.5.0

### Minor Changes

- 037e8ee: Add delete cache functionality to vernLLM

### Patch Changes

- e18b37e: add keywords to package

## 0.4.0

### Minor Changes

- 5e029b2: Add support for multi-turn conversation history via the `history` option in `CallParams`. Conversation history is now forwarded to all supported providers, including assistant messages, enabling native multi-turn interactions.

## 0.3.0

### Minor Changes

- 761d860: Make LLM throw LLMerror(timeout) when timeout aborts request

### Patch Changes

- afd54d9: Affirm directory on package

## 0.2.1

### Patch Changes

- ee5bb90: Connect repo with package

## 0.2.0

### Minor Changes

- dbce6e2: created a `tsconfig.base.json` which the `tsconfig.json` extends from

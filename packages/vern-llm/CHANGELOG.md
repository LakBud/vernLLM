# vern-llm

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

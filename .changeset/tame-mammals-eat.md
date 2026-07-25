---
'vern-llm': minor
---

Added named adapter aliases for 9 more OpenAI-compatible LLM providers to `vern-llm`: OpenRouter, Perplexity, DeepInfra, Novita, Hyperbolic, Moonshot, Zhipu, LM Studio, and vLLM.

**Changes:**

- **Source**: `fromOpenRouter`, `fromPerplexity`, `fromDeepInfra`, `fromNovita`, `fromHyperbolic`, `fromMoonshot`, `fromZhipu`, `fromLMStudio`, `fromVLLM` added as aliases for `fromOpenAICompatible` in `packages/vern-llm/src/adapters/openaiCompatible.ts`, re-exported via `adapters/index.ts` and `src/index.ts`
- **Tests**: added to the parameterized alias check in `openaiCompatible.unit.test.ts` (18/18 passing)
- **Docs**: `adapters/index.mdx` and `adapters/openai-compatible.mdx` updated to list all providers as named wrappers
- **Homepage**: `home.utils.ts` `providers` array expanded with icons + doc links for all new providers (fixed `Vllm` casing to match actual `@lobehub/icons` export)
- **Changeset**: minor bump for `vern-llm` — purely additive, no breaking changes

**Verified**: `tsc --noEmit` clean on both the package and docs app, `dist/` rebuilt via `tsdown` to include new exports, `changeset status` confirms minor bump.

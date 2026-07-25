---
'vern-llm': minor
---

Add named adapter aliases for additional OpenAI-compatible LLM providers.

**Changes:**

- **Source**: Added new provider aliases for additional OpenAI-compatible providers, all backed by `fromOpenAICompatible` with zero request/response transformation.
- **Adapters**: Added support for providers including xAI, NVIDIA NIM, Vercel AI Gateway, Cloudflare Workers AI, GitHub Models, Nebius, SambaNova, Baseten, DashScope, Featherless, Friendli, SiliconFlow, LiteLLM Proxy, Parasail, StepFun, MiniMax, Lambda Labs, Snowflake Cortex, Anyscale, Lepton, kluster.ai, Inference.net, Infermatic, AtlasCloud, and 01.AI.
- **Docs**: Expanded `openai-compatible` documentation with the full list of supported named adapters and clarified `fromOpenAICompatible()` as the generic fallback.
- **Homepage**: Updated the provider list with the newly supported providers.
- **Changeset**: Minor bump for `vern-llm` — purely additive, no breaking changes.

---
'vern-llm': patch
---

Fixed the named OpenAI compatible adapters (fromGroq, fromMistral, fromDeepSeek, and the rest).

Every named adapter validates baseURL instead of trying to inject it. The check compares the client's baseURL origin (protocol + host) against the provider's known origin; the path (e.g. `/v1`) is not enforced, since that's an API-version/routing detail a provider can change independently of its identity (Together has already moved `.xyz` -> `.ai`). If baseURL is missing or resolves to a different origin than expected — including pointing at a different provider's domain entirely, not just still being unset or left at OpenAI's default — the adapter throws an LLMError with type 'validation' and issues: { expectedBaseURL, actualBaseURL }, naming the expected origin. Catch this with isLLMError like any other vern-llm error. You must now pass baseURL yourself inside new OpenAI({ ... }) at construction time for every named provider, using that provider's documented path from the adapter's function or the adapters/openai-compatible docs table (only the origin portion of that value is actually checked). This is a breaking change for anyone relying on a named adapter to set baseURL for them, though that reliance was already broken and silently producing wrong results.

Also corrected several endpoint values that were wrong or outdated:

- Novita: api.novita.ai/openai (was .../v3/openai)
- SiliconFlow: api.siliconflow.cn/v1 (was the .com domain)
- Lambda AI: api.lambda.ai/v1 (was the old lambdalabs.com domain)
- StepFun: api.stepfun.ai/v1 as the global endpoint (was the China-only .com endpoint)
- 01.AI: api.lingyiwanwu.com/v1 (was api.01.ai/v1, which hosts 01.AI's site, not its API). Only confirmed via third party sources so far, flagged in code and docs.
- Nebius: api.tokenfactory.nebius.com/v1, following its 2026 rebrand to Nebius Token Factory (was api.studio.nebius.com/v1)
- Together AI: api.together.ai/v1 as the primary documented endpoint (api.together.xyz/v1 still works as an alias)

fromNvidiaNIM, fromVercelAIGateway, and fromBaseten were previously treated as having no fixed endpoint and always required baseURL. They do have a real shared endpoint and now validate against it like the other named adapters.

fromAnyscale has no expected endpoint anymore. Its old self serve API was shut down in 2024; there is no fixed URL to validate against, so it always requires baseURL.

fromLepton no longer names an expected endpoint. Lepton AI was acquired by NVIDIA and rebranded to NVIDIA DGX Cloud Lepton, so the old per-model URL pattern is not reliable anymore; it always requires baseURL.

fromOllama still always requires baseURL. Ollama Cloud does have a fixed endpoint (https://ollama.com/v1), but validating against it by default would risk accepting a local user's misconfigured client as if it were correct, since most fromOllama usage points at a local server instead.

fromGitHubModels and fromKlusterAI have been removed entirely, along with their homepage logos. GitHub Models was fully retired on July 30, 2026 for every customer. kluster.ai was sunset in 2026 after being acquired by MITO. Neither has a replacement to point at.

fromPerplexity's doc comment now notes that Sonar Chat Completions is labeled legacy in favor of Perplexity's newer Agent API, though the endpoint and expected value here remain valid for chat.completions.create.

Adapters that genuinely have no fixed endpoint (Ollama, LM Studio, vLLM, Snowflake Cortex, Cloudflare Workers AI, Anyscale, Lepton) continue to always require baseURL, as they did before this fix.

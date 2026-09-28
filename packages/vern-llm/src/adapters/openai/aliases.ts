import { fromOpenAICompatible } from './openaiCompatible.js';

/**
 * The OpenAI SDK. Wrap it rather than passing it directly, since newer SDK
 * content-part types no longer typecheck against `LLMClient`.
 */
export const fromOpenAI = fromOpenAICompatible;

/** Groqs SDK matches the OpenAI wire format */
export const fromGroq = fromOpenAICompatible;

/** Mistral's OpenAI-compatible endpoint, which accepts `stream_options.include_usage`. */
export const fromMistral = fromOpenAICompatible;

/** DeepSeeks API is OpenAI-compatible */
export const fromDeepSeek = fromOpenAICompatible;

/** Cerebras inference API is OpenAI-compatible */
export const fromCerebras = fromOpenAICompatible;

/** Together AIs API is OpenAI-compatible */
export const fromTogether = fromOpenAICompatible;

/** Fireworks AIs API is OpenAI-compatible */
export const fromFireworks = fromOpenAICompatible;

/** Ollama's OpenAI-compatible `/v1/chat/completions` endpoint, not its native `/api/chat`. */
export const fromOllama = fromOpenAICompatible;

/** OpenRouter's API is OpenAI-compatible */
export const fromOpenRouter = fromOpenAICompatible;

/** Perplexity's API is OpenAI-compatible */
export const fromPerplexity = fromOpenAICompatible;

/** DeepInfra's API is OpenAI-compatible */
export const fromDeepInfra = fromOpenAICompatible;

/** Novita's API is OpenAI-compatible */
export const fromNovita = fromOpenAICompatible;

/** Hyperbolic's API is OpenAI-compatible */
export const fromHyperbolic = fromOpenAICompatible;

/** Moonshot's (Kimi) API is OpenAI-compatible */
export const fromMoonshot = fromOpenAICompatible;

/** Zhipu's (GLM) API is OpenAI-compatible */
export const fromZhipu = fromOpenAICompatible;

/**
 * LM Studio exposes an OpenAI-compatible endpoint at `/v1/chat/completions`.
 * Point an OpenAI SDK instance's `baseURL` at your local LM Studio server.
 */
export const fromLMStudio = fromOpenAICompatible;

/**
 * vLLM's OpenAI-compatible server mode exposes `/v1/chat/completions`.
 * Point an OpenAI SDK instance's `baseURL` at your vLLM server.
 */
export const fromVLLM = fromOpenAICompatible;

/** xAI's Grok API is OpenAI-compatible */
export const fromXAI = fromOpenAICompatible;

/** NVIDIA NIM's hosted and self-hosted endpoints are OpenAI-compatible */
export const fromNvidiaNIM = fromOpenAICompatible;

/** Vercel AI Gateway is OpenAI-compatible */
export const fromVercelAIGateway = fromOpenAICompatible;

/** Cloudflare Workers AI exposes an OpenAI-compatible endpoint */
export const fromCloudflareWorkersAI = fromOpenAICompatible;

/** Nebius AI Studio is OpenAI-compatible */
export const fromNebius = fromOpenAICompatible;

/** SambaNova Cloud's API is OpenAI-compatible */
export const fromSambaNova = fromOpenAICompatible;

/** Baseten's model hosting exposes an OpenAI-compatible endpoint */
export const fromBaseten = fromOpenAICompatible;

/** Featherless AI's API is OpenAI-compatible */
export const fromFeatherless = fromOpenAICompatible;

/** Friendli AI's serving endpoint is OpenAI-compatible */
export const fromFriendli = fromOpenAICompatible;

/** SiliconFlow's API is OpenAI-compatible */
export const fromSiliconFlow = fromOpenAICompatible;

/** Parasail's inference API is OpenAI-compatible */
export const fromParasail = fromOpenAICompatible;

/** StepFun's API is OpenAI-compatible */
export const fromStepFun = fromOpenAICompatible;

/** MiniMax's API is OpenAI-compatible */
export const fromMiniMax = fromOpenAICompatible;

/** Lambda Labs' Inference API is OpenAI-compatible */
export const fromLambdaLabs = fromOpenAICompatible;

/** Snowflake Cortex's LLM endpoint is OpenAI-compatible */
export const fromSnowflakeCortex = fromOpenAICompatible;

/** Anyscale Endpoints' API is OpenAI-compatible */
export const fromAnyscale = fromOpenAICompatible;

/** Lepton AI's inference API is OpenAI-compatible */
export const fromLepton = fromOpenAICompatible;

/** Inference.net's API is OpenAI-compatible */
export const fromInferenceNet = fromOpenAICompatible;

/** Infermatic's API is OpenAI-compatible */
export const fromInfermatic = fromOpenAICompatible;

/** AtlasCloud's inference API is OpenAI-compatible */
export const fromAtlasCloud = fromOpenAICompatible;

/** 01.AI's (Yi models) API is OpenAI-compatible */
export const from01AI = fromOpenAICompatible;

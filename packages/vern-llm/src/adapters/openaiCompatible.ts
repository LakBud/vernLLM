import type { LLMClient } from '../types/index.js';

/**
 * Passthrough adapter for any SDK/client whose `chat.completions.create`
 * already matches the OpenAI wire format 1:1 : this covers most hosted
 * inference providers, since "OpenAI-compatible" is a de facto standard for
 * chat completion APIs. No transformation happens here, this exists purely
 * so call sites read clearly (`fromMistral(client)` vs handing a Mistral
 * client to something typed for OpenAI) and so a real transformation could
 * be added later, per-provider, without a breaking change.
 *
 * Not every SDKs own TypeScript types line up exactly with `LLMClient`
 * (extra fields, stricter unions, etc.), so this takes `unknown` and casts:
 * the actual compatibility contract is the JSON each provider sends and
 * receives over the wire, not the SDKs TS types.
 */
export function fromOpenAICompatible(client: unknown): LLMClient {
  return client as LLMClient;
}

/** Groqs SDK matches the OpenAI wire format */
export const fromGroq = fromOpenAICompatible;

/** Mistrals `chat.completions`-shaped client (or their OpenAI-compat endpoint) */
export const fromMistral = fromOpenAICompatible;

/** DeepSeeks API is OpenAI-compatible */
export const fromDeepSeek = fromOpenAICompatible;

/** Cerebras inference API is OpenAI-compatible */
export const fromCerebras = fromOpenAICompatible;

/** Together AIs API is OpenAI-compatible */
export const fromTogether = fromOpenAICompatible;

/** Fireworks AIs API is OpenAI-compatible */
export const fromFireworks = fromOpenAICompatible;

/**
 * Ollama exposes an OpenAI-compatible endpoint at `/v1/chat/completions`
 * (as opposed to its native `/api/chat` format, which differs). Point an
 * OpenAI SDK instances `baseURL` at your Ollama server and pass it here:
 * this does not talk to Ollamas native API directly.
 */
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

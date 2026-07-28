import { assertSupportedImageMimeType } from '../internal/imageFormat.js';

import type { ContentBlock, LLMClient } from '../types/index.js';

/** OpenAI's native per-part content shape for a user message. */
type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/**
 * Translates a VernLLM `ContentBlock[]` into OpenAI's wire-level content
 * array. Text blocks become `{ type: 'text', text }`; image blocks become
 * `{ type: 'image_url', image_url: { url } }` with the base64 payload
 * inlined as a `data:` URL, since our `ContentBlock` shape (`{ type:
 * 'image', data, mimeType }`) is provider-agnostic and doesn't itself match
 * OpenAI's wire format.
 */
function toOpenAIContent(blocks: ContentBlock[]): OpenAIContentPart[] {
  return blocks.map((block) =>
    block.type === 'image'
      ? {
          type: 'image_url',
          image_url: {
            url: `data:${assertSupportedImageMimeType(block.mimeType)};base64,${block.data}`,
          },
        }
      : { type: 'text', text: block.text },
  );
}

/**
 * Adapter for any SDK/client whose `chat.completions.create` already
 * matches the OpenAI wire format: this covers most hosted inference
 * providers, since "OpenAI-compatible" is a de facto standard for chat
 * completion APIs. Almost everything passes straight through untouched,
 * this exists purely so call sites read clearly (`fromMistral(client)` vs
 * handing a Mistral client to something typed for OpenAI) and so a real
 * transformation could be added later, per-provider, without a breaking
 * change.
 *
 * The one thing that isn't a pure passthrough: a `ContentBlock[]`
 * `userContent` is translated into OpenAI's native `image_url` content-part
 * shape, since VernLLM's `ContentBlock` is intentionally provider-agnostic
 * rather than a copy of any one provider's wire format.
 *
 * Not every SDKs own TypeScript types line up exactly with `LLMClient`
 * (extra fields, stricter unions, etc.), so this takes `unknown` and casts:
 * the actual compatibility contract is the JSON each provider sends and
 * receives over the wire, not the SDKs TS types.
 */
export function fromOpenAICompatible(client: unknown): LLMClient {
  const raw = client as LLMClient;

  return {
    chat: {
      completions: {
        async create(params, options) {
          const messages = params.messages.map((m) =>
            m.role === 'user' && Array.isArray(m.content)
              ? { ...m, content: toOpenAIContent(m.content) }
              : m,
          );

          return raw.chat.completions.create(
            { ...params, messages } as Parameters<LLMClient['chat']['completions']['create']>[0],
            options,
          );
        },
      },
    },
  };
}

// LLM aliases

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

/** xAI's Grok API is OpenAI-compatible */
export const fromXAI = fromOpenAICompatible;

/** NVIDIA NIM's hosted and self-hosted endpoints are OpenAI-compatible */
export const fromNvidiaNIM = fromOpenAICompatible;

/** Vercel AI Gateway is OpenAI-compatible */
export const fromVercelAIGateway = fromOpenAICompatible;

/** Cloudflare Workers AI exposes an OpenAI-compatible endpoint */
export const fromCloudflareWorkersAI = fromOpenAICompatible;

/** GitHub Models is OpenAI-compatible */
export const fromGitHubModels = fromOpenAICompatible;

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

/** kluster.ai's inference API is OpenAI-compatible */
export const fromKlusterAI = fromOpenAICompatible;

/** Inference.net's API is OpenAI-compatible */
export const fromInferenceNet = fromOpenAICompatible;

/** Infermatic's API is OpenAI-compatible */
export const fromInfermatic = fromOpenAICompatible;

/** AtlasCloud's inference API is OpenAI-compatible */
export const fromAtlasCloud = fromOpenAICompatible;

/** 01.AI's (Yi models) API is OpenAI-compatible */
export const from01AI = fromOpenAICompatible;

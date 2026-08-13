/**
 * IMPORTANT: named adapters here do not set baseURL for you. They validate
 * it and throw a clear error naming the correct value if it looks missing
 * or unset. Mutating client.baseURL after construction does not work with
 * the official OpenAI SDK, so every provider's expected URL is documented
 * on its own function and checked at call time instead of silently injected.
 *
 * All URLs below are checked against each provider's own docs as of
 * August 2026.
 */

import { LLMError } from '../types/index.js';
import { assertSupportedImageMimeType } from './internal/imageFormat.js';

import type { ContentBlock, LLMClient, WireStreamChunk } from '../types/../index.js';

/** OpenAI's native per part content shape for a user message. */
type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/** Converts ContentBlock[] into OpenAI's content array shape. */
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

/** One chunk of an OpenAI style streamed chat completion. */
interface OpenAIStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

/** Converts VernLLM messages into OpenAI's wire shape. Shared by create and createStream. */
function toOpenAIMessages(
  params: Parameters<LLMClient['chat']['completions']['create']>[0],
): unknown[] {
  return params.messages.map((m) => {
    if (m.role === 'user' && Array.isArray(m.content)) {
      return { ...m, content: toOpenAIContent(m.content) };
    }

    if (m.role === 'tool') {
      const { is_error: _isError, ...openAIToolMessage } = m;
      return openAIToolMessage;
    }

    return m;
  });
}

/** Converts one OpenAI stream chunk into zero or more WireStreamChunks. */
function* toWireStreamChunks(chunk: OpenAIStreamChunk): Generator<WireStreamChunk> {
  const delta = chunk.choices?.[0]?.delta;

  if (delta?.content) {
    yield { type: 'text-delta', delta: delta.content };
  }

  if (delta?.tool_calls?.length) {
    for (const toolCall of delta.tool_calls) {
      yield {
        type: 'tool_call_delta',
        index: toolCall.index,
        id: toolCall.id,
        name: toolCall.function?.name,
        argumentsDelta: toolCall.function?.arguments,
      };
    }
  }

  if (chunk.usage) {
    yield { type: 'usage', usage: chunk.usage };
  }
}

/**
 * Adapter for any client whose chat.completions.create already matches
 * OpenAI's wire format. Named aliases below all use this so call sites
 * read clearly, and so a real per provider transform can be added later
 * without a breaking change.
 *
 * The one real transform: ContentBlock[] userContent is converted to
 * OpenAI's image_url content part shape.
 *
 * Client is typed unknown since SDK TS types vary by provider and version;
 * the real compatibility contract is the JSON on the wire, not the types.
 *
 * createStream calls the same create with stream: true, plus
 * stream_options.include_usage when supported, and translates each SSE
 * chunk via toWireStreamChunks.
 *
 * Long running reasoning models: this adapter reads the SDK's parsed
 * stream, not raw SSE, so it can't see keep alive pings. A long silent gap
 * (common with reasoning models) can trip chunkIdleTimeoutMs. Raise or
 * disable it per call if needed.
 */
export interface OpenAICompatibleAdapterOptions {
  /**
   * Whether the provider supports stream_options.include_usage. Defaults
   * true. Set false if a provider errors on that field.
   */
  supportsStreamUsage?: boolean;
}

export function fromOpenAICompatible(
  client: unknown,
  options: OpenAICompatibleAdapterOptions = {},
): LLMClient {
  const raw = client as LLMClient;
  const { supportsStreamUsage = true } = options;

  const rawCreate = raw.chat.completions.create.bind(raw.chat.completions) as unknown as (
    params: unknown,
    options: { signal: AbortSignal },
  ) => Promise<unknown> | AsyncIterable<OpenAIStreamChunk>;

  return {
    chat: {
      completions: {
        async create(params, options) {
          const messages = toOpenAIMessages(params);

          return raw.chat.completions.create(
            { ...params, messages } as Parameters<LLMClient['chat']['completions']['create']>[0],
            options,
          );
        },

        async *createStream(params, options) {
          const messages = toOpenAIMessages(params);

          const stream = (await rawCreate(
            {
              ...params,
              messages,
              stream: true,
              ...(supportsStreamUsage ? { stream_options: { include_usage: true } } : {}),
            },
            options,
          )) as AsyncIterable<OpenAIStreamChunk>;

          for await (const chunk of stream) {
            yield* toWireStreamChunks(chunk);
          }
        },
      },
    },
  };
}

// Named provider aliases

/**
 * Checks the client's baseURL against the provider's known origin and
 * throws LLMError('validation') if it's missing or points somewhere else,
 * with the exact value to pass and a `.issues` payload of
 * { expectedBaseURL, actualBaseURL }. Callers using isLLMError can branch
 * on err.type === 'validation' to catch this alongside vern-llm's other
 * deterministic, non-retryable errors.
 *
 * The check compares origins (protocol + host) only, not the full path.
 * Path segments like `/v1` are API-version/routing details a provider can
 * change independently of its identity (Together has already moved
 * `.xyz` -> `.ai`; a future `/v1` -> `/v2` shouldn't start failing this
 * guard). `expectedOrigin` should therefore be passed as an origin with no
 * path, e.g. 'https://api.groq.com', not '.../openai/v1'. Any documented
 * conventional path belongs in the calling function's JSDoc and error
 * text, not in what's actually compared.
 *
 * A client baseURL that fails to parse as a URL, is unset, or resolves to
 * an origin that doesn't match is treated as unset/wrong and throws.
 */
function validateBaseURL(
  client: unknown,
  expectedOrigin: string,
  options?: OpenAICompatibleAdapterOptions,
): LLMClient {
  const c = client as { baseURL?: string };

  let actualOrigin: string | undefined;
  try {
    actualOrigin = c.baseURL ? new URL(c.baseURL).origin : undefined;
  } catch {
    actualOrigin = undefined;
  }

  const mismatched = !actualOrigin || actualOrigin !== new URL(expectedOrigin).origin;

  if (mismatched) {
    throw new LLMError(
      `This client's baseURL is ${c.baseURL ? `'${c.baseURL}'` : 'unset'}, but this adapter ` +
        `expects an origin of '${expectedOrigin}'. Pass baseURL: '${expectedOrigin}' (plus that ` +
        `provider's documented path) when constructing the client, e.g. ` +
        `new OpenAI({ apiKey, baseURL: '${expectedOrigin}/...' }). Setting client.baseURL after ` +
        `construction does not work with the official OpenAI SDK.`,
      'validation',
      undefined,
      { expectedBaseURL: expectedOrigin, actualBaseURL: c.baseURL },
    );
  }
  return fromOpenAICompatible(client, options);
}

/**
 * Throws LLMError('validation') if the client has no baseURL set. Used
 * for providers with no fixed endpoint (self hosted, or account/
 * deployment scoped), so a forgotten baseURL fails loudly instead of
 * silently hitting OpenAI's own endpoint with the wrong key.
 */
function requireBaseURL(
  client: unknown,
  providerName: string,
  options?: OpenAICompatibleAdapterOptions,
): LLMClient {
  const c = client as { baseURL?: string };
  if (!c.baseURL) {
    throw new LLMError(
      `${providerName} has no fixed base URL. Pass baseURL when constructing the client.`,
      'validation',
    );
  }
  return fromOpenAICompatible(client, options);
}

/** Named alias for the OpenAI SDK itself. Also handles multimodal translation and streaming. */
export const fromOpenAI = fromOpenAICompatible;

/** Groq. Requires baseURL to be https://api.groq.com/openai/v1 */
export function fromGroq(client: unknown, options?: OpenAICompatibleAdapterOptions): LLMClient {
  return validateBaseURL(client, 'https://api.groq.com', options);
}

/** Mistral. Requires baseURL to be https://api.mistral.ai/v1 */
export function fromMistral(client: unknown, options?: OpenAICompatibleAdapterOptions): LLMClient {
  return validateBaseURL(client, 'https://api.mistral.ai', options);
}

/** DeepSeek. Requires baseURL to be https://api.deepseek.com/v1 */
export function fromDeepSeek(client: unknown, options?: OpenAICompatibleAdapterOptions): LLMClient {
  return validateBaseURL(client, 'https://api.deepseek.com', options);
}

/** Cerebras. Requires baseURL to be https://api.cerebras.ai/v1 */
export function fromCerebras(client: unknown, options?: OpenAICompatibleAdapterOptions): LLMClient {
  return validateBaseURL(client, 'https://api.cerebras.ai', options);
}

/** Together AI. Requires baseURL to be https://api.together.ai/v1, the current primary documented endpoint (api.together.xyz/v1 also still works) */
export function fromTogether(client: unknown, options?: OpenAICompatibleAdapterOptions): LLMClient {
  return validateBaseURL(client, 'https://api.together.ai', options);
}

/** Fireworks AI. Requires baseURL to be https://api.fireworks.ai/inference/v1 */
export function fromFireworks(
  client: unknown,
  options?: OpenAICompatibleAdapterOptions,
): LLMClient {
  return validateBaseURL(client, 'https://api.fireworks.ai', options);
}

/** Ollama. Self hosted by default, no fixed URL. Set baseURL yourself, e.g. http://localhost:11434/v1. Ollama Cloud is a separate hosted option at https://ollama.com/v1, opt in only, since defaulting to it would silently route local calls to a paid cloud service. */
export function fromOllama(client: unknown, options?: OpenAICompatibleAdapterOptions): LLMClient {
  return requireBaseURL(client, 'Ollama', options);
}

/** OpenRouter. Requires baseURL to be https://openrouter.ai/api/v1 */
export function fromOpenRouter(
  client: unknown,
  options?: OpenAICompatibleAdapterOptions,
): LLMClient {
  return validateBaseURL(client, 'https://openrouter.ai', options);
}

/** Perplexity. Requires baseURL to be https://api.perplexity.ai. Sonar Chat Completions at this URL still works but is now labeled legacy in favor of Perplexity's newer Agent API, which uses the Responses shape instead of chat.completions.create */
export function fromPerplexity(
  client: unknown,
  options?: OpenAICompatibleAdapterOptions,
): LLMClient {
  return validateBaseURL(client, 'https://api.perplexity.ai', options);
}

/** DeepInfra. Requires baseURL to be https://api.deepinfra.com/v1/openai */
export function fromDeepInfra(
  client: unknown,
  options?: OpenAICompatibleAdapterOptions,
): LLMClient {
  return validateBaseURL(client, 'https://api.deepinfra.com', options);
}

/** Novita. Requires baseURL to be https://api.novita.ai/openai */
export function fromNovita(client: unknown, options?: OpenAICompatibleAdapterOptions): LLMClient {
  return validateBaseURL(client, 'https://api.novita.ai', options);
}

/** Hyperbolic. Requires baseURL to be https://api.hyperbolic.xyz/v1 */
export function fromHyperbolic(
  client: unknown,
  options?: OpenAICompatibleAdapterOptions,
): LLMClient {
  return validateBaseURL(client, 'https://api.hyperbolic.xyz', options);
}

/** Moonshot (Kimi). Requires baseURL to be https://api.moonshot.ai/v1 */
export function fromMoonshot(client: unknown, options?: OpenAICompatibleAdapterOptions): LLMClient {
  return validateBaseURL(client, 'https://api.moonshot.ai', options);
}

/** Zhipu (GLM). Requires baseURL to be https://open.bigmodel.cn/api/paas/v4 */
export function fromZhipu(client: unknown, options?: OpenAICompatibleAdapterOptions): LLMClient {
  return validateBaseURL(client, 'https://open.bigmodel.cn', options);
}

/** LM Studio. Self hosted, no fixed URL. Set baseURL yourself, e.g. http://localhost:1234/v1 */
export function fromLMStudio(client: unknown, options?: OpenAICompatibleAdapterOptions): LLMClient {
  return requireBaseURL(client, 'LM Studio', options);
}

/** vLLM. Self hosted, no fixed URL. Set baseURL yourself. */
export function fromVLLM(client: unknown, options?: OpenAICompatibleAdapterOptions): LLMClient {
  return requireBaseURL(client, 'vLLM', options);
}

/** xAI Grok. Requires baseURL to be https://api.x.ai/v1 */
export function fromXAI(client: unknown, options?: OpenAICompatibleAdapterOptions): LLMClient {
  return validateBaseURL(client, 'https://api.x.ai', options);
}

/** NVIDIA NIM. Requires baseURL to be the hosted catalog https://integrate.api.nvidia.com/v1 (self hosted NIM containers should pass baseURL themselves) */
export function fromNvidiaNIM(
  client: unknown,
  options?: OpenAICompatibleAdapterOptions,
): LLMClient {
  return validateBaseURL(client, 'https://integrate.api.nvidia.com', options);
}

/** Vercel AI Gateway. Requires baseURL to be https://ai-gateway.vercel.sh/v1 (same URL for every account, identity comes from the API key) */
export function fromVercelAIGateway(
  client: unknown,
  options?: OpenAICompatibleAdapterOptions,
): LLMClient {
  return validateBaseURL(client, 'https://ai-gateway.vercel.sh', options);
}

/** Cloudflare Workers AI. No default, URL is account scoped. Set baseURL yourself. */
export function fromCloudflareWorkersAI(
  client: unknown,
  options?: OpenAICompatibleAdapterOptions,
): LLMClient {
  return requireBaseURL(client, 'Cloudflare Workers AI', options);
}

/** Nebius, rebranded Nebius Token Factory in 2026. Requires baseURL to be https://api.tokenfactory.nebius.com/v1 */
export function fromNebius(client: unknown, options?: OpenAICompatibleAdapterOptions): LLMClient {
  return validateBaseURL(client, 'https://api.tokenfactory.nebius.com', options);
}

/** SambaNova Cloud. Requires baseURL to be https://api.sambanova.ai/v1 */
export function fromSambaNova(
  client: unknown,
  options?: OpenAICompatibleAdapterOptions,
): LLMClient {
  return validateBaseURL(client, 'https://api.sambanova.ai', options);
}

/** Baseten. Requires baseURL to be the shared Model APIs catalog https://inference.baseten.co/v1 (dedicated custom deployments use their own URL, pass baseURL yourself for those) */
export function fromBaseten(client: unknown, options?: OpenAICompatibleAdapterOptions): LLMClient {
  return validateBaseURL(client, 'https://inference.baseten.co', options);
}

/** Featherless AI. Requires baseURL to be https://api.featherless.ai/v1 */
export function fromFeatherless(
  client: unknown,
  options?: OpenAICompatibleAdapterOptions,
): LLMClient {
  return validateBaseURL(client, 'https://api.featherless.ai', options);
}

/** Friendli AI. Requires baseURL to be https://api.friendli.ai/serverless/v1 */
export function fromFriendli(client: unknown, options?: OpenAICompatibleAdapterOptions): LLMClient {
  return validateBaseURL(client, 'https://api.friendli.ai', options);
}

/** SiliconFlow. Requires baseURL to be https://api.siliconflow.cn/v1 */
export function fromSiliconFlow(
  client: unknown,
  options?: OpenAICompatibleAdapterOptions,
): LLMClient {
  return validateBaseURL(client, 'https://api.siliconflow.cn', options);
}

/** Parasail. Requires baseURL to be https://api.parasail.io/v1 */
export function fromParasail(client: unknown, options?: OpenAICompatibleAdapterOptions): LLMClient {
  return validateBaseURL(client, 'https://api.parasail.io', options);
}

/**
 * StepFun. Requires baseURL to be the global endpoint
 * https://api.stepfun.ai/v1. China accounts use https://api.stepfun.com/v1
 * with a separate key; pass baseURL explicitly for that case.
 */
export function fromStepFun(client: unknown, options?: OpenAICompatibleAdapterOptions): LLMClient {
  return validateBaseURL(client, 'https://api.stepfun.ai', options);
}

/** MiniMax. Requires baseURL to be https://api.minimax.io/v1 (China accounts use api.minimaxi.com) */
export function fromMiniMax(client: unknown, options?: OpenAICompatibleAdapterOptions): LLMClient {
  return validateBaseURL(client, 'https://api.minimax.io', options);
}

/** Lambda AI. Requires baseURL to be https://api.lambda.ai/v1 */
export function fromLambdaLabs(
  client: unknown,
  options?: OpenAICompatibleAdapterOptions,
): LLMClient {
  return validateBaseURL(client, 'https://api.lambda.ai', options);
}

/** Snowflake Cortex. No default, URL is account/region scoped. Set baseURL yourself. */
export function fromSnowflakeCortex(
  client: unknown,
  options?: OpenAICompatibleAdapterOptions,
): LLMClient {
  return requireBaseURL(client, 'Snowflake Cortex', options);
}

/**
 * Anyscale's self serve Endpoints API shut down August 1, 2024. No fixed
 * URL exists anymore; set baseURL to your own Anyscale Platform endpoint.
 */
export function fromAnyscale(client: unknown, options?: OpenAICompatibleAdapterOptions): LLMClient {
  return requireBaseURL(client, 'Anyscale', options);
}

/** Lepton AI was acquired by NVIDIA in 2025 and is now NVIDIA DGX Cloud Lepton. The old per model URL pattern may no longer work. No default is applied, set baseURL yourself and check current NVIDIA DGX Cloud Lepton docs. */
export function fromLepton(client: unknown, options?: OpenAICompatibleAdapterOptions): LLMClient {
  return requireBaseURL(client, 'Lepton AI', options);
}

/** Inference.net. Requires baseURL to be https://api.inference.net/v1 */
export function fromInferenceNet(
  client: unknown,
  options?: OpenAICompatibleAdapterOptions,
): LLMClient {
  return validateBaseURL(client, 'https://api.inference.net', options);
}

/** Infermatic. Requires baseURL to be https://api.totalgpt.ai/v1 */
export function fromInfermatic(
  client: unknown,
  options?: OpenAICompatibleAdapterOptions,
): LLMClient {
  return validateBaseURL(client, 'https://api.totalgpt.ai', options);
}

/** AtlasCloud. Requires baseURL to be https://api.atlascloud.ai/v1, confirmed directly from their own live docs */
export function fromAtlasCloud(
  client: unknown,
  options?: OpenAICompatibleAdapterOptions,
): LLMClient {
  return validateBaseURL(client, 'https://api.atlascloud.ai', options);
}

/** 01.AI (Yi models). Requires baseURL to be https://api.lingyiwanwu.com/v1. Only confirmed via third party sources, not 01.AI's own docs directly, so double check this one against 01.AI's current site before relying on it */
export function from01AI(client: unknown, options?: OpenAICompatibleAdapterOptions): LLMClient {
  return validateBaseURL(client, 'https://api.lingyiwanwu.com', options);
}

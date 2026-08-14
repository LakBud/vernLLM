import { assertSupportedImageMimeType } from './internal/imageFormat.js';

import type { ContentBlock, LLMClient, WireStreamChunk } from '../types/index.js';

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

/** One chunk of an OpenAI-shaped `chat.completions.create({ stream: true })` SSE stream. */
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

/**
 * Translates VernLLM's provider-agnostic `messages` (the one part of a
 * request that isn't a pure passthrough for OpenAI-compatible clients) into
 * OpenAI's native wire shape. Shared between `create` and `createStream` so
 * both go through identical message translation.
 */
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

/**
 * Translates one OpenAI-shaped SSE chunk into zero or more `WireStreamChunk`s.
 * A single chunk can carry a text delta, one or more tool-call argument
 * deltas (each keyed by `index`, OpenAI's own convention for streaming
 * parallel tool calls, mirrored directly by VernLLM's `tool_call_delta`
 * shape so accumulation composes without translation), and/or a final
 * usage block (present only when `stream_options.include_usage` is set,
 * which this adapter always sets).
 */
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
 *
 * `createStream` is implemented by calling the same underlying
 * `chat.completions.create` with `stream: true` (and, for providers that
 * support it, `stream_options: { include_usage: true }`, so a final usage
 * block arrives), the OpenAI SDK, and every OpenAI-compatible client
 * modeled on it, returns an `AsyncIterable` of SSE chunks instead of a
 * single completion object when `stream: true` is set. Each chunk is
 * translated into `WireStreamChunk`(s) via `toWireStreamChunks`.
 *
 * Note on long-running reasoning models: this adapter consumes the
 * underlying SDK's already-parsed stream rather than raw SSE bytes, so
 * unlike `fromFetch`/`fromAnthropic` it cannot see comment-only keep-alive
 * ping frames. Combined with `chunkIdleTimeoutMs`'s 30 second default and
 * `reasoningEffort` (documented to have long silent gaps for o-series and
 * similar models), a long-running reasoning call on this adapter can trip
 * the idle timeout even though the provider is still working. Raise or
 * disable `chunkIdleTimeoutMs` per call for those routes, see `CallParams`.
 */
export interface OpenAICompatibleAdapterOptions {
  /**
   * Whether the provider supports `stream_options.include_usage`. Not
   * every "OpenAI-compatible" provider is guaranteed to, so this defaults
   * to `true` (matching OpenAI, Groq, Mistral, and most others observed)
   * and should be set to `false` for a provider verified not to support
   * it. When `false`, `stream_options` is omitted entirely and no usage
   * block will arrive on the stream; callers relying on streamed `usage`
   * with such a provider won't get one.
   */
  supportsStreamUsage?: boolean;
}

export function fromOpenAICompatible(
  client: unknown,
  options: OpenAICompatibleAdapterOptions = {},
): LLMClient {
  const raw = client as LLMClient;
  const { supportsStreamUsage = true } = options;

  // The underlying client's `create`, called with `stream: true`, returns
  // an AsyncIterable of `OpenAIStreamChunk` rather than
  // `LLMClient['create']`'s normal single-completion return type, hence
  // `unknown` here and a cast at the call site, same rationale as casting
  // the whole client above: the wire contract, not the SDK's own TS types,
  // is what's actually being relied on.
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

// LLM aliases

/**
 * Named alias for the OpenAI SDK itself. A raw `new OpenAI(...)` instance
 * structurally matches most of `LLMClient`, but newer `openai` SDK major
 * versions have widened `ChatCompletionContentPart` (e.g. adding a `file`
 * variant) in ways that no longer structurally satisfy VernLLM's
 * provider-agnostic `ContentBlock[]` on `userContent`, so passing the SDK
 * instance directly can fail to typecheck depending on the installed
 * `openai` version. Wrapping with `fromOpenAI()` (a plain alias of
 * `fromOpenAICompatible()`) sidesteps that by translating through
 * `unknown` at the boundary, and also picks up multimodal image
 * translation and `createStream` wiring that a raw client doesn't have.
 * See Migration Notes for details.
 */
export const fromOpenAI = fromOpenAICompatible;

/** Groqs SDK matches the OpenAI wire format */
export const fromGroq = fromOpenAICompatible;

/**
 * Mistrals `chat.completions`-shaped client (or their OpenAI-compat
 * endpoint). Mistral supports `stream_options.include_usage` (added after
 * an earlier period where it returned a 422 for unrecognized fields, per
 * Mistral's changelog and streaming docs), so this is a plain alias like
 * the others, `supportsStreamUsage` defaults to `true`.
 */
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

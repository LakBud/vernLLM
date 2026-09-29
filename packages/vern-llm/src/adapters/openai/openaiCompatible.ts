import {
  attachRateLimitHint,
  parseOpenAIRateLimitHeaders,
} from '../../internal/utils/rate-limit/rateLimitHint.utils.js';
import { rateLimitHintChunk, sendWithHeaders } from '../internal/rateLimitHeaders.js';
import {
  resolveEffortTokenTable,
  type EffortTokenTable,
} from '../internal/reasoningBudget.utils.js';
import { openAICompatibleProvider } from './provider.js';
import {
  applyReasoningBudget,
  applyReasoningModelParams,
  requiresNoReasoning,
  withNoReasoning,
} from './reasoning.js';
import { ensureJsonKeyword, toOpenAIMessages } from './request.js';
import { toWireStreamChunks } from './stream.js';
import { normalizeUsage } from './usage.js';

import type { Logger } from '../../logger.js';
import type { LLMClient } from '../../types/index.js';
import type { ModelCapabilityOverride } from '../internal/nativeStructuredOutput.js';
import type { OpenAIStreamChunk } from './types.js';

type WireRequest = Parameters<LLMClient['chat']['completions']['create']>[0];
type WireResponse = Awaited<ReturnType<LLMClient['chat']['completions']['create']>>;

/** Optional configuration for `fromOpenAICompatible`. */
export interface OpenAICompatibleAdapterOptions {
  /**
   * Whether the provider accepts `stream_options.include_usage`. Default
   * `true`. With `false`, `stream_options` is omitted and streams report no
   * usage.
   */
  supportsStreamUsage?: boolean;
  /**
   * Overrides the token counts `budgetTokens` buckets into when
   * `reasoningEffort` isn't set. Omitted tiers keep the default.
   */
  reasoningEffortTokens?: Partial<EffortTokenTable>;
  /**
   * Whether the client supports `.withResponse()`, which AIMD's proactive
   * path needs. Default `false`, since the client can't be verified.
   */
  supportsWithResponse?: boolean;
  /**
   * The provider, in the OpenTelemetry `gen_ai.provider.name` vocabulary,
   * reported on `AttemptContext.adapter`. When omitted it is read off a well
   * known `baseURL` host, and left unset otherwise.
   */
  provider?: string;
  /**
   * Models that only take `tools` on Chat Completions with
   * `reasoning_effort: "none"`, replacing the built in rule (bare `gpt-` ids
   * of major 6 and later, except `-chat` ids). With tools, `"none"` is sent,
   * or the call throws `unsupported_capability` when reasoning was asked for.
   */
  noReasoningToolModels?: ModelCapabilityOverride;
}

/**
 * Adapter for any client whose `chat.completions.create` speaks the OpenAI
 * wire format. Requests pass through, except for message translation and
 * the model specific rewrites above. The client is `unknown` because SDK
 * types drift from `LLMClient`; the wire format is the contract.
 */
export function fromOpenAICompatible(
  client: unknown,
  options: OpenAICompatibleAdapterOptions = {},
): LLMClient {
  const raw = client as LLMClient;
  const { supportsStreamUsage = true, supportsWithResponse = false } = options;
  const effortTokenTable = resolveEffortTokenTable(options.reasoningEffortTokens);
  const provider = openAICompatibleProvider(client, options.provider);
  let logger: Logger | undefined;

  // `extra` carries the stream fields, which VernLLM's own wire type, like
  // `reasoning_effort: 'none'`, doesn't list, hence the cast on the way out.
  const buildRequest = (params: WireRequest, extra: object = {}) => {
    const noReasoning = requiresNoReasoning(params, options.noReasoningToolModels);
    const messages = ensureJsonKeyword(toOpenAIMessages(params), params.response_format);

    return withNoReasoning(
      applyReasoningModelParams(
        applyReasoningBudget({ ...params, messages, ...extra }, effortTokenTable),
      ),
      noReasoning,
      logger,
    ) as WireRequest;
  };

  const send = <T>(request: WireRequest, signal: { signal: AbortSignal }) =>
    sendWithHeaders<T>(() => raw.chat.completions.create(request, signal), supportsWithResponse);

  return {
    adapter: { name: 'openai-compatible', ...(provider ? { provider } : {}) },
    setLogger(next) {
      logger = next;
    },
    chat: {
      completions: {
        async create(params, requestOptions) {
          const { data, headers } = await send<WireResponse>(buildRequest(params), requestOptions);

          // Normalized before the hint is attached: the hint is a non enumerable symbol property,
          // which the copy would drop.
          const result = data?.usage ? { ...data, usage: normalizeUsage(data.usage) } : data;

          if (headers && result && typeof result === 'object') {
            attachRateLimitHint(result, parseOpenAIRateLimitHeaders(headers));
          }

          return result;
        },

        async *createStream(params, requestOptions) {
          const request = buildRequest(params, {
            stream: true,
            ...(supportsStreamUsage ? { stream_options: { include_usage: true } } : {}),
          });
          const { data: stream, headers } = await send<AsyncIterable<OpenAIStreamChunk>>(
            request,
            requestOptions,
          );

          // Headers arrive before the body, so the hint precedes content.
          if (headers) {
            const hint = rateLimitHintChunk(parseOpenAIRateLimitHeaders(headers));
            if (hint) yield hint;
          }

          for await (const chunk of stream) {
            yield* toWireStreamChunks(chunk);
          }
        },
      },
    },
  };
}

import {
  attachRateLimitHint,
  parseAnthropicRateLimitHeaders,
} from '../../internal/utils/rate-limit/rateLimitHint.utils.js';
import { rateLimitHintChunk, sendWithHeaders } from '../internal/rateLimitHeaders.js';
import {
  resolveEffortTokenTable,
  type EffortTokenTable,
} from '../internal/reasoningBudget.utils.js';
import { buildAnthropicRequestBody } from './request.js';
import { toWireResponse } from './response.js';
import { toWireStreamChunks } from './stream.js';

import type { LLMClient } from '../../types/index.js';
import type { ModelCapabilityOverride } from '../internal/nativeStructuredOutput.js';
import type {
  AnthropicClient,
  AnthropicRequestBody,
  AnthropicResponse,
  AnthropicStreamEvent,
} from './types.js';

/** Optional configuration for `fromAnthropic`. */
export interface AnthropicAdapterOptions {
  /**
   * Models that support native structured output (`output_config.format`),
   * which can be combined with real `tools`. No default: other models
   * emulate `jsonSchema` as a forced tool call.
   */
  nativeStructuredOutputModels?: ModelCapabilityOverride;
  /** Overrides the token count each `reasoningEffort` tier maps onto. Omitted tiers keep the default. */
  reasoningEffortTokens?: Partial<EffortTokenTable>;
  /**
   * Adds models that only accept adaptive thinking, on top of the built in
   * rule (Claude Opus 4.7 and later, every Claude 5 tier model).
   */
  adaptiveOnlyModels?: ModelCapabilityOverride;
  /**
   * Replaces the built in list of models that reject a forced `tool_choice`
   * (Claude Fable 5.1 and later, Opus 5.5 and later, every Claude major 6
   * and later). On these, `toolChoice: 'required'` or `{ name }` throws
   * `unsupported_capability` before dispatch, and `jsonSchema` always uses
   * native structured output.
   */
  forcedToolChoiceUnsupportedModels?: ModelCapabilityOverride;
  /**
   * Whether `messages.create` supports `.withResponse()`, which AIMD's
   * proactive path needs. Default `false`, since a fake or thin wrapper
   * won't implement it.
   */
  supportsWithResponse?: boolean;
}

/**
 * Wraps an Anthropic SDK client as an `LLMClient`. `jsonSchema` uses native
 * structured output on covered models and a forced tool call elsewhere,
 * which can't be combined with `tools`. `json_object` throws, since
 * Anthropic can't guarantee it.
 */
export function fromAnthropic(
  anthropicClient: AnthropicClient,
  options?: AnthropicAdapterOptions,
): LLMClient {
  const effortTokenTable = resolveEffortTokenTable(options?.reasoningEffortTokens);
  const supportsWithResponse = options?.supportsWithResponse ?? false;

  const buildBody = (params: Parameters<LLMClient['chat']['completions']['create']>[0]) =>
    buildAnthropicRequestBody(
      params,
      options?.nativeStructuredOutputModels,
      effortTokenTable,
      options?.adaptiveOnlyModels,
      options?.forcedToolChoiceUnsupportedModels,
    );

  // The body is widened since, with `stream: true`, the SDK takes an extra
  // field and returns an iterable of events the structural type doesn't cover.
  const send = <T>(body: unknown, signal: { signal: AbortSignal }) =>
    sendWithHeaders<T>(
      () => anthropicClient.messages.create(body as AnthropicRequestBody, signal),
      supportsWithResponse,
    );

  return {
    // Lets core downgrade a default jsonMode to plain text instead of
    // requesting json_object, which this adapter throws on.
    supportsJsonObjectMode: false,
    // Anthropic's input rate limit skips cache reads, so the limiter must too.
    cacheReadsCountTowardRateLimit: false,
    adapter: { name: 'anthropic', provider: 'anthropic' },
    chat: {
      completions: {
        async create(params, requestOptions) {
          const { body, toolName } = buildBody(params);
          const { data, headers } = await send<AnthropicResponse>(body, requestOptions);
          const result = toWireResponse(data, toolName);

          if (headers) attachRateLimitHint(result, parseAnthropicRateLimitHeaders(headers));

          return result;
        },

        async *createStream(params, requestOptions) {
          const { body, toolName } = buildBody(params);
          const { data: stream, headers } = await send<AsyncIterable<AnthropicStreamEvent>>(
            { ...body, stream: true },
            requestOptions,
          );

          // Headers arrive before the body, so the hint precedes content.
          if (headers) {
            const hint = rateLimitHintChunk(parseAnthropicRateLimitHeaders(headers));
            if (hint) yield hint;
          }

          yield* toWireStreamChunks(stream, toolName);
        },
      },
    },
  };
}

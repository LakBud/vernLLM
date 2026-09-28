import {
  ConverseCommand,
  ConverseStreamCommand,
  type BedrockRuntimeClient,
} from '@aws-sdk/client-bedrock-runtime';
import { LLMError, type LLMClient } from 'vern-llm';

import { buildBedrockRequest } from './request.js';
import { toWireResponse } from './response.js';
import { toWireStreamChunks } from './stream.js';
import { resolveEffortTokenTable } from './thinking.js';

import type { BedrockAdapterOptions, ResolvedOptions } from './types.js';

/**
 * Wraps an AWS SDK `BedrockRuntimeClient` as an `LLMClient`, driving it with
 * `ConverseCommand` and `ConverseStreamCommand`. Converse is unified across
 * Bedrock's model families, so any model that supports it works.
 *
 * `jsonSchema` uses `outputConfig.textFormat` on models in
 * `nativeStructuredOutputModels`, and on models that reject a forced
 * `tool_choice`; elsewhere it is a forced single tool call, which can't be
 * combined with `tools`. `json_object` throws, since Converse can't guarantee
 * it. `reasoningEffort` and `budgetTokens` reach Claude models only.
 */
export function fromBedrock(
  client: BedrockRuntimeClient,
  options?: BedrockAdapterOptions,
): LLMClient {
  const resolved: ResolvedOptions = {
    toolUseSupportedModels: options?.toolUseSupportedModels,
    nativeStructuredOutputModels: options?.nativeStructuredOutputModels,
    effortTokenTable: resolveEffortTokenTable(options?.reasoningEffortTokens),
    adaptiveOnlyModels: options?.adaptiveOnlyModels,
    forcedToolChoiceUnsupportedModels: options?.forcedToolChoiceUnsupportedModels,
    claudeModels: options?.claudeModels,
  };

  return {
    supportsJsonObjectMode: false,
    adapter: { name: 'bedrock', provider: 'aws.bedrock' },
    chat: {
      completions: {
        async create(params, requestOptions) {
          const { request, toolName } = buildBedrockRequest(params, resolved);

          const response = await client.send(new ConverseCommand(request), {
            abortSignal: requestOptions.signal,
          });

          return toWireResponse(response, toolName);
        },

        async *createStream(params, requestOptions) {
          const { request, toolName } = buildBedrockRequest(params, resolved);

          const { stream } = await client.send(new ConverseStreamCommand(request), {
            abortSignal: requestOptions.signal,
          });

          if (!stream) {
            throw new LLMError(
              'Bedrock ConverseStreamCommand response did not include a stream. This can happen ' +
                "if the request or the model doesn't actually support Converse streaming.",
              'api',
              { code: 'server_error' },
            );
          }

          yield* toWireStreamChunks(stream, toolName);
        },
      },
    },
  };
}

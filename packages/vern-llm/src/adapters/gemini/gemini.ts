import { unsupportedCapability } from '../internal/errors.js';
import {
  resolveEffortTokenTable,
  type EffortTokenTable,
} from '../internal/reasoningBudget.utils.js';
import { sdkRetryWarning } from '../internal/sdkRetries.js';
import { buildGeminiRequest } from './request.js';
import { toWireResponse } from './response.js';
import { toWireStreamChunks } from './stream.js';

import type { LLMClient } from '../../types/index.js';
import type { ModelCapabilityOverride } from '../internal/nativeStructuredOutput.js';
import type { GeminiClient, GeminiModels } from './types.js';

/** Optional configuration for `fromGemini`. */
export interface GeminiAdapterOptions {
  /** Overrides the token count each `reasoningEffort` tier maps onto. Omitted tiers keep the default. */
  reasoningEffortTokens?: Partial<EffortTokenTable>;
  /**
   * Adds models that use `thinkingLevel` instead of `thinkingBudget`, on top
   * of the built in rule (Gemini 3 and later).
   */
  thinkingLevelModels?: ModelCapabilityOverride;
}

/** A client built by hand may leave `vertexai` unset, so no provider is claimed for it. */
function geminiProvider(client: GeminiClient): { provider?: string } {
  if (client.vertexai === true) return { provider: 'gcp.vertex_ai' };
  if (client.vertexai === false) return { provider: 'gcp.gemini' };
  return {};
}

/**
 * Retries the client makes on its own. `@google/genai` only retries when
 * `httpOptions.retryOptions` is set, and then `attempts`, which counts the
 * first call, defaults to 5. The SDK types `httpOptions` as private, so it is
 * read structurally and anything unexpected counts as no retry.
 */
function geminiRetries(client: GeminiClient): number | undefined {
  const retryOptions = (client as { httpOptions?: { retryOptions?: { attempts?: unknown } } })
    .httpOptions?.retryOptions;
  if (!retryOptions || typeof retryOptions !== 'object') return undefined;

  const attempts = retryOptions.attempts ?? 5;
  return typeof attempts === 'number' ? attempts - 1 : undefined;
}

/**
 * Wraps the top level `@google/genai` client as an `LLMClient`. `ai.models`
 * throws at construction, since only the top level client says whether it
 * talks to Vertex AI or the Gemini API. `responseSchema` and `tools` combine
 * natively.
 */
export function fromGemini(client: GeminiClient, options?: GeminiAdapterOptions): LLMClient {
  const effortTokenTable = resolveEffortTokenTable(options?.reasoningEffortTokens);
  const thinkingLevelModels = options?.thinkingLevelModels;
  // `ai.models` has generateContent itself and no `models`. Checked at runtime
  // since plain JS callers get no type error for it.
  const models: GeminiModels | undefined = client.models;
  if (!models && typeof (client as Partial<GeminiModels>).generateContent === 'function') {
    throw unsupportedCapability(
      'fromGemini takes the top level client: pass ai (new GoogleGenAI(...)), not ai.models.',
      'top_level_client',
    );
  }

  if (typeof models?.generateContent !== 'function') {
    throw unsupportedCapability(
      'fromGemini requires a client with models.generateContent: pass ai (new GoogleGenAI(...)).',
      'generateContent',
    );
  }

  const warnOnSdkRetries = sdkRetryWarning(
    'gemini',
    () => geminiRetries(client),
    'Remove httpOptions.retryOptions from the client, or set its attempts to 1,',
  );

  const generateContent = models.generateContent.bind(models);
  const generateContentStream =
    typeof models.generateContentStream === 'function'
      ? models.generateContentStream.bind(models)
      : undefined;

  return {
    adapter: { name: 'gemini', ...geminiProvider(client) },
    setLogger: warnOnSdkRetries,
    chat: {
      completions: {
        async create(params, options) {
          const request = buildGeminiRequest(params, effortTokenTable, thinkingLevelModels);
          request.config = { ...request.config, abortSignal: options.signal };

          const response = await generateContent(request);

          return toWireResponse(response);
        },

        async *createStream(params, options) {
          if (!generateContentStream) {
            throw unsupportedCapability(
              'stream: true requires a Gemini client with generateContentStream',
              'generateContentStream',
            );
          }

          const request = buildGeminiRequest(params, effortTokenTable, thinkingLevelModels);
          request.config = { ...request.config, abortSignal: options.signal };

          const stream = await generateContentStream(request);

          yield* toWireStreamChunks(stream);
        },
      },
    },
  };
}

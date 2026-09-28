export {
  fromAnthropic,
  type AnthropicClient,
  type AnthropicAdapterOptions,
} from './claude/index.js';
export { fromGemini, type GeminiClient, type GeminiAdapterOptions } from './gemini/index.js';
export {
  fromFetch,
  type FetchAdapterConfig,
  type RequestLike,
  type ResponseLike,
  type StreamRequestLike,
} from './fetch/index.js';
export { parseSseStream, SSE_PING } from './internal/sse.js';

// Shared building blocks for adapters that ship as their own package, so
// each provider keeps one implementation of these rules.
export {
  planClaudeStructuredOutput,
  resolveClaudeThinking,
  type ClaudeStructuredOutputPlan,
  type ClaudeThinking,
} from './internal/claudeRequest.js';
export {
  supportsNativeStructuredOutput,
  type ModelCapabilityOverride,
} from './internal/nativeStructuredOutput.js';
export {
  assertForcedJsonSchemaToolInputIsObject,
  throwMissingForcedJsonSchemaTool,
} from './internal/forcedJsonSchemaTool.js';
export {
  assertForcedToolChoiceSupported,
  rejectsForcedToolChoice,
} from './internal/forcedToolChoice.js';
export {
  assertSupportedImageMimeType,
  type SupportedImageMimeType,
} from './internal/imageFormat.js';
export {
  assertNoForcedToolChoiceWithThinking,
  assertValidClaudeBudgetTokens,
  budgetTokensToEffort,
  effortToBudgetTokens,
  resolveEffortTokenTable,
  supportsManualThinkingBudget,
  toClaudeAdaptiveEffort,
  type ClaudeAdaptiveEffort,
  type EffortTokenTable,
} from './internal/reasoningBudget.utils.js';
export {
  type OpenAICompatibleAdapterOptions,
  fromOpenAICompatible,
  fromOpenAI,
  fromGroq,
  fromMistral,
  fromDeepSeek,
  fromCerebras,
  fromTogether,
  fromFireworks,
  fromOllama,
  fromOpenRouter,
  fromPerplexity,
  fromDeepInfra,
  fromNovita,
  fromHyperbolic,
  fromMoonshot,
  fromZhipu,
  fromLMStudio,
  fromVLLM,
  fromXAI,
  fromNvidiaNIM,
  fromVercelAIGateway,
  fromCloudflareWorkersAI,
  fromNebius,
  fromSambaNova,
  fromBaseten,
  fromFeatherless,
  fromFriendli,
  fromSiliconFlow,
  fromParasail,
  fromStepFun,
  fromMiniMax,
  fromLambdaLabs,
  fromSnowflakeCortex,
  fromAnyscale,
  fromLepton,
  fromInferenceNet,
  fromInfermatic,
  fromAtlasCloud,
  from01AI,
} from './openai/index.js';

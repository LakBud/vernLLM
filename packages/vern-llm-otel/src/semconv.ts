// Names are copied from the GenAI semantic conventions instead of imported from
// `@opentelemetry/semantic-conventions/incubating`, whose entry point may break in a
// minor release. Renaming after a spec change is then a one file edit.

/** Core semantic conventions release the GenAI definitions below were written against. */
export const SEMCONV_VERSION = '1.44.0';

/** Every GenAI convention is still Development status, so names can change between releases. */
export const SEMCONV_STATUS = 'development';

/** Instrumentation scope name for the tracer and meter. */
export const INSTRUMENTATION_NAME = 'vern-llm-otel';

export const ATTR = {
  operationName: 'gen_ai.operation.name',
  providerName: 'gen_ai.provider.name',
  requestModel: 'gen_ai.request.model',
  requestMaxTokens: 'gen_ai.request.max_tokens',
  requestTemperature: 'gen_ai.request.temperature',
  requestStream: 'gen_ai.request.stream',
  requestReasoningLevel: 'gen_ai.request.reasoning.level',
  responseTimeToFirstChunk: 'gen_ai.response.time_to_first_chunk',
  outputType: 'gen_ai.output.type',
  usageInputTokens: 'gen_ai.usage.input_tokens',
  usageOutputTokens: 'gen_ai.usage.output_tokens',
  usageReasoningOutputTokens: 'gen_ai.usage.reasoning.output_tokens',
  tokenType: 'gen_ai.token.type',
  inputMessages: 'gen_ai.input.messages',
  outputMessages: 'gen_ai.output.messages',
  systemInstructions: 'gen_ai.system_instructions',
  toolDefinitions: 'gen_ai.tool.definitions',
  errorType: 'error.type',
  httpStatusCode: 'http.response.status_code',
} as const;

/** VernLLM specific telemetry. Never placed under `gen_ai.`, which the spec owns. */
export const VERNLLM_ATTR = {
  requestId: 'vernllm.request_id',
  primaryProvider: 'vernllm.primary.provider',
  primaryModel: 'vernllm.primary.model',
  answeredProvider: 'vernllm.answered.provider',
  answeredModel: 'vernllm.answered.model',
  usedFallback: 'vernllm.used_fallback',
  fallbackIndex: 'vernllm.fallback_index',
  fallbackAttempts: 'vernllm.fallback.attempts',
  totalAttempts: 'vernllm.total_attempts',
  streaming: 'vernllm.streaming',
  noAttemptReason: 'vernllm.no_attempt.reason',
  shortCircuitBy: 'vernllm.short_circuit.by',
  contentCaptured: 'vernllm.content.captured',
  target: 'vernllm.target',
  attempt: 'vernllm.attempt',
  isFallback: 'vernllm.is_fallback',
  requestReasoningEffort: 'vernllm.request.reasoning_effort',
  requestBudgetTokens: 'vernllm.request.budget_tokens',
  rateLimitWaitMs: 'vernllm.rate_limit.wait_ms',
  usageFailed: 'vernllm.usage.failed',
  // Metric only attributes.
  provider: 'vernllm.provider',
  model: 'vernllm.model',
  callOutcome: 'vernllm.call.outcome',
  retryAfterHonored: 'vernllm.retry_after_honored',
  fallbackFrom: 'vernllm.fallback.from',
  fallbackTo: 'vernllm.fallback.to',
  rateLimitReason: 'vernllm.rate_limit.reason',
  circuitFrom: 'vernllm.circuit.from',
  circuitTo: 'vernllm.circuit.to',
} as const;

export const METRIC = {
  tokenUsage: 'gen_ai.client.token.usage',
  operationDuration: 'gen_ai.client.operation.duration',
  timeToFirstChunk: 'gen_ai.client.operation.time_to_first_chunk',
  callDuration: 'vernllm.call.duration',
  callAttempts: 'vernllm.call.attempts',
  retryCount: 'vernllm.retry.count',
  retryDelay: 'vernllm.retry.delay',
  fallbackCount: 'vernllm.fallback.count',
  rateLimitWait: 'vernllm.rate_limit.wait',
  circuitTransitions: 'vernllm.circuit.transitions',
  usageFailureCount: 'vernllm.usage_failure.count',
} as const;

export const SPAN = {
  call: 'vernllm.call',
  attemptFallbackName: 'vernllm.attempt',
} as const;

export const SPAN_EVENT = {
  retry: 'vernllm.retry',
  fallback: 'vernllm.fallback',
  circuitState: 'vernllm.circuit_state',
  middleware: 'vernllm.middleware',
} as const;

/** Attribute keys on the VernLLM span events. */
export const EVENT_ATTR = {
  attempt: 'attempt',
  delayMs: 'delay_ms',
  retryAfterHonored: 'retry_after_honored',
  from: 'from',
  to: 'to',
  elapsedMs: 'elapsed_ms',
  provider: 'provider',
  model: 'model',
  consecutiveFailures: 'consecutive_failures',
  name: 'name',
  hook: 'hook',
  patchedFields: 'patched_fields',
} as const;

export const OPERATION_CHAT = 'chat';
export const OUTPUT_TYPE_TEXT = 'text';
export const OUTPUT_TYPE_JSON = 'json';
export const TOKEN_TYPE_INPUT = 'input';
export const TOKEN_TYPE_OUTPUT = 'output';

/** Low cardinality `error.type` for anything that is not a VernLLM error. */
export const ERROR_TYPE_OTHER = '_OTHER';
export const ERROR_CODE_FALLBACK_EXHAUSTED = 'fallback_exhausted';

export const NO_ATTEMPT_REASON = {
  cacheHit: 'cache_hit',
  coalesced: 'coalesced',
  shortCircuit: 'short_circuit',
} as const;

export const CALL_OUTCOME = {
  ok: 'ok',
  error: 'error',
  cacheHit: 'cache_hit',
  coalesced: 'coalesced',
  shortCircuit: 'short_circuit',
} as const;

export const UNIT_TOKEN = '{token}';
export const UNIT_SECOND = 's';
export const UNIT_ATTEMPT = '{attempt}';

export const TOKEN_USAGE_BUCKETS: readonly number[] = [
  1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864,
];

export const DURATION_BUCKETS: readonly number[] = [
  0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92,
];

export const ATTEMPT_COUNT_BUCKETS: readonly number[] = [1, 2, 3, 4, 5, 8, 13];

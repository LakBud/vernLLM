# vern-llm-bedrock

## 0.1.0

### Minor Changes

- 5ec7a11: `promptTokens` now includes cache reads and writes, and the cache split is reported on `TokenUsage`.

  `fromBedrock` adds `cacheReadInputTokens` and `cacheWriteInputTokens` to Converse's `inputTokens`, which excludes them. Before, `promptTokens` plus `completionTokens` fell short of Bedrock's `totalTokens` whenever prompt caching was on. Now they agree, and `totalTokens` is still what Bedrock reports. `TokenUsage` gains `cacheReadTokens`, `cacheWriteTokens` and `cacheWriteTokensByTtl`, the last read from `cacheDetails` and keyed by its TTL label.

  ```ts
  // Before: inputTokens alone
  usage.promptTokens; // 10

  // After: inputTokens plus cache reads and writes
  usage.promptTokens; // 10010
  usage.cacheReadTokens; // 8000
  usage.cacheWriteTokens; // 2000
  ```

  Existing code keeps compiling. At runtime, `promptTokens` is higher on calls that use the prompt cache, in `onUsage`, the `'usage'` event and OpenTelemetry's `gen_ai.usage.input_tokens`. The token rate limiter is unchanged, since Bedrock's total already included cache tokens. See [Migration Notes](/docs/migration-notes#300-prompttokens-includes-cache-reads-and-writes).

- df1d501: Add `vern-llm-bedrock`, the AWS Bedrock Converse adapter for `vern-llm`, built on the AWS SDK's `BedrockRuntimeClient`. `@aws-sdk/client-bedrock-runtime` and `vern-llm` 3.0.0 are peer dependencies.

  ```ts
  import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
  import { VernLLM } from 'vern-llm';
  import { fromBedrock } from 'vern-llm-bedrock';

  const llm = new VernLLM({
    client: fromBedrock(new BedrockRuntimeClient({ region: 'us-east-1', maxAttempts: 1 })),
    model: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
  });
  ```

  `fromBedrock` takes a `BedrockRuntimeClient` and sends `ConverseCommand` and `ConverseStreamCommand` through its `send`. Requests and responses are typed with the SDK's own types, and stream events the adapter doesn't model, including the SDK's generated `$unknown` member, are skipped.

  It carries everything `fromBedrock` did in `vern-llm` 2.x: native structured output, forced tool calls for `jsonSchema` elsewhere, the `forcedToolChoiceUnsupportedModels` rule for newer Claude models, Claude reasoning kept in history for tool loops, keep-alive pings while reasoning streams, and a local error for `toolChoice: 'none'` with tools. The adapter names itself `bedrock` with provider `aws.bedrock` on `LLMClient.adapter`.

### Patch Changes

- 5a5ff4b: Warn when the AWS SDK retries on its own.

  `fromBedrock` logs a `warn` at `VernLLM` construction, once per process, when the client's resolved `maxAttempts` is above 1, since those retries are hidden from VernLLM's retries, circuit breaker, rate limiter, and events. The client is never modified. Pass `maxAttempts: 1` to the `BedrockRuntimeClient` to silence it. An explicit `retryStrategy` overrides `maxAttempts`, so remove it or configure it for one attempt. The warning reads the attempt count of the SDK's own `StandardRetryStrategy` and `AdaptiveRetryStrategy`, including one you pass in. A fully custom strategy exposes no count, so it can't be checked and gets no warning even if it still retries.

- Updated dependencies: vern-llm@3.0.0

# vern-llm-bedrock

## 0.2.0

### Minor Changes

- c8ad06e: `bedrockGuardrail` can check images and judge grounding. `images: true` sends each PNG or JPEG image as its own request (`unsupportedImages`, `imageConcurrency`), and `aws.grounding()` judges an answer against the call's tool results with the guardrail's contextual grounding check.
- 6a68511: `vern-llm-bedrock/guardrail` adds `bedrockGuardrail()`, a detector that runs text through an Amazon Bedrock guardrail with `ApplyGuardrail`.

  A detector is a function from text segments to findings. A finding is labeled `pii.<type>`, `regex.<name>`, `word.<type>`, `topic.<name>` or `content.<type>`. Matches from sensitive information, regexes and word lists are located in the text and become spans. Topics and content filters return no match, so they cover the whole text. Bedrock's own action is ignored, so the caller decides what a finding means, and a guardrail in detect mode works too.

  ```ts
  import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
  import { bedrockGuardrail } from 'vern-llm-bedrock/guardrail';

  const aws = bedrockGuardrail({
    client: new BedrockRuntimeClient({ region: 'eu-west-1' }),
    guardrailIdentifier: 'gr-abc123',
    guardrailVersion: '3',
  });

  const signal = AbortSignal.timeout(5000);
  await aws([{ text: 'Mail jane@acme.com', source: 'user' }], signal);
  // [{ segment: 0, label: 'pii.EMAIL', start: 5, end: 18 }]

  aws.only('pii', 'topic'); // a detector for some kinds, over the same requests and cache
  ```

  Views and calls share the requests in flight and the cached results, so a text is not sent again while its result is cached. A cache miss makes one request per chunk of a long text, and requests in flight are limited by `concurrency`. The cache keeps labels and offsets, never text. A `DRAFT` version warns once and is never cached, since it can change. Any error, or a response without assessments, is thrown as it is.

  Nothing changes for existing code: it is a new entry point, so `fromBedrock` and the size of the root bundle stay as they were.

### Patch Changes

- d245f72: `fromBedrock` leaves `temperature` out of `inferenceConfig` for Claude 4.7 and later, which reject it, so a default config call works. `temperatureUnsupportedModels` replaces that list with your own list or predicate.
- 224632a: `fromBedrock` reports a `stopReason` of `guardrail_intervened`, `content_filtered` or `refusal` as a provider refusal, so a response with no content fails once as `model_refused` instead of retrying and falling back.

  Streams do the same on `messageStop`. A guardrail's canned message, which arrives as content, is still returned as an answer. The fix needs `vern-llm` 3.1.0 or later, since older cores ignore the new `refusal` field and keep failing as `empty_response`.

- c41037c: The adapter reports every `stopReason` as a finish reason, not only `max_tokens`: `end_turn` and `stop_sequence` as `stop`, `tool_use` as `tool_calls`, `guardrail_intervened` as `guardrail`, `content_filtered` as `content_filter`, and `refusal` as `refusal`. On a stream it also yields a `finish` chunk. With `vern-llm` setting `CallMeta.finishReason`, a guardrail that stops an answer after text came back is visible to the caller.
- Updated dependencies: vern-llm@3.1.0

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

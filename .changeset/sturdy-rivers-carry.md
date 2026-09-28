---
'vern-llm-bedrock': minor
---

Add `vern-llm-bedrock`, the AWS Bedrock Converse adapter for `vern-llm`, built on the AWS SDK's `BedrockRuntimeClient`. `@aws-sdk/client-bedrock-runtime` and `vern-llm` 3.0.0 are peer dependencies.

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

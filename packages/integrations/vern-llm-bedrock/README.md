<p align="center">
  <img src="https://raw.githubusercontent.com/LakBud/vernLLM/main/apps/docs/public/integrations/bedrock.png" alt="VernLLM + AWS Bedrock banner"/>
</p>

<p align="center">
  <a href="https://vernllm.dev/docs/integrations/bedrock">Documentation</a> ·
  <a href="https://github.com/LakBud/vernLLM/tree/main/packages/integrations/vern-llm-bedrock">Package</a> ·
  <a href="https://www.npmjs.com/package/vern-llm-bedrock">npm</a>
</p>

<h1 align="center">vern-llm-bedrock</h1>

<p align="center">An AWS Bedrock Converse adapter for <a href="https://github.com/LakBud/vernLLM/tree/main/packages/vern-llm">vern-llm</a>, built on the AWS SDK's <code>BedrockRuntimeClient</code>. Every model Converse supports gets retries, timeouts, fallback, rate limiting and circuit breaking from vern-llm.</p>

<p align="center"><sub>Amazon Bedrock is a trademark of Amazon.com, Inc. This is an unofficial community integration, not affiliated with or endorsed by Amazon Web Services.</sub></p>

## Install

```
npm i vern-llm-bedrock @aws-sdk/client-bedrock-runtime
```

`vern-llm` and `@aws-sdk/client-bedrock-runtime` are peer dependencies, so this package shares the copies your app already uses.

## Usage

```ts
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { VernLLM } from 'vern-llm';
import { fromBedrock } from 'vern-llm-bedrock';

const llm = new VernLLM({
  client: fromBedrock(new BedrockRuntimeClient({ region: 'us-east-1' })),
  model: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
});
```

Pass `maxAttempts: 1` to `BedrockRuntimeClient` so vern-llm's retries are the only ones.

## What you get

| Feature           | Behavior                                                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Structured output | `jsonSchema` as native `outputConfig.textFormat` on models you list, else a forced tool call.                                       |
| Tools             | `tools` and `toolChoice` map to Converse `toolConfig`. `toolChoice: 'none'` with tools throws, since Converse has no equivalent.    |
| Reasoning         | `reasoningEffort` and `budgetTokens` reach Claude models, with reasoning kept in history for tool loops.                            |
| Streaming         | `ConverseStreamCommand` events become vern-llm chunks, and in-band stream exceptions become `LLMError`s the retry loop understands. |
| Telemetry         | The adapter names itself `bedrock` with provider `aws.bedrock`, so middleware such as `vern-llm-otel` reports the right provider.   |

## Guardrails

`vern-llm-bedrock/guardrail` adds `bedrockGuardrail`, a detector: a function from text segments to findings, run through an Amazon Bedrock guardrail with `ApplyGuardrail`. It finds topics, content filter hits, sensitive information, regex matches and words, and leaves what to do about them to the caller.

```ts
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { bedrockGuardrail } from 'vern-llm-bedrock/guardrail';

const aws = bedrockGuardrail({
  client: new BedrockRuntimeClient({ region: 'eu-west-1' }),
  guardrailIdentifier: 'gr-abc123',
  guardrailVersion: '3',
});

const found = await aws([{ text: 'Mail jane@acme.com', source: 'user' }], signal);
// [{ segment: 0, label: 'pii.EMAIL', start: 5, end: 18 }]
```

A finding is labeled `pii.<type>`, `regex.<name>`, `word.<type>`, `topic.<name>` or `content.<type>`. Matches in sensitive information, regexes and words become spans. Topics and content filters cover the whole text. `.only('pii', 'topic')` gives a detector for some kinds that shares one request per text and one cache. The text you check is sent to Bedrock, and a `DRAFT` version warns once and is never cached.

See the [documentation](https://vernllm.dev/docs/integrations/bedrock) for every option.

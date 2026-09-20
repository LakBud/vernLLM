<p align="center">
  <img src="https://raw.githubusercontent.com/LakBud/vernLLM/main/apps/docs/public/integrations/otel.png" alt="VernLLM + OpenTelemetry banner"/>
</p>

<h1 align="center">vern-llm-otel</h1>

<p align="center">OpenTelemetry traces and metrics for <a href="https://github.com/LakBud/vernLLM/tree/main/packages/vern-llm">vern-llm</a>, following the GenAI semantic conventions. One middleware turns every call into spans and metrics, with retries, fallbacks, rate limit waits, and circuit breaker transitions visible. Docs: <a href="https://vernllm.dev/docs/integrations/otel">vernllm.dev</a></p>

<p align="center"><sub>OpenTelemetry is a Cloud Native Computing Foundation project. This is an unofficial community integration, not affiliated with or endorsed by the CNCF or the OpenTelemetry project.</sub></p>

## Install

```
npm i vern-llm-otel @opentelemetry/api
```

`vern-llm` and `@opentelemetry/api` are peer dependencies, so this package shares the copies your app already uses. Start your OpenTelemetry SDK as usual before the first call.

## Usage

```ts
import { VernLLM } from 'vern-llm';
import { otelMiddleware } from 'vern-llm-otel';

const llm = new VernLLM({
  client,
  model: 'gpt-4o',
  middleware: [otelMiddleware({ providerNames: { primary: 'openai' } })],
});
```

`providerNames` maps a VernLLM target (`primary`, `fallback[0]`, or a `name` you set) to `gen_ai.provider.name`. Register one instance per `VernLLM`.

## What you get

| Signal  | Emitted                                                                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------------------ |
| Traces  | A `vernllm.call` span per call and a `chat {model}` span per attempt, so every retry and fallback is its own child span. |
| Metrics | `gen_ai.client.token.usage`, `gen_ai.client.operation.duration`, and `gen_ai.client.operation.time_to_first_chunk`.      |
| Metrics | `vernllm.*` counters and histograms for retries, fallbacks, rate limit waits, and circuit transitions.                   |

Streams are observed without touching the chunks or `finalResult`. Spans nest under whatever span is active when the call starts.

## Privacy

Prompts and responses are never recorded by default. Turn on `captureContent` to record them, with `redact`, `maxLength`, and a per call `when` gate. Error messages are never recorded, only the error code. `recordExceptions` adds an `exception` event with that code, and stack traces are a separate opt in because they can contain the message.

## Stability

The GenAI semantic conventions are in Development status, so attribute and metric names can change in a later release. Set `genAiConventions: false` to keep only `vernllm.*` telemetry when a provider SDK already emits GenAI spans.

<h1 align="center">vern-llm-logger</h1>

<p align="center">Structured call logs, rolling latency percentiles, and slow call and error detection for <a href="https://github.com/LakBud/vernLLM/tree/main/packages/vern-llm">vern-llm</a>.</p>

One middleware that writes a structured record for every call, keeps rolling latency percentiles per provider and model, marks slow calls, groups repeated errors, samples successes, and writes periodic summaries. A failure inside the logger never changes a call.

## Usage

```ts
import { VernLLM } from 'vern-llm';
import { jsonSink, loggerMiddleware } from 'vern-llm-logger';

const llm = new VernLLM({
  client,
  model: 'gpt-4o',
  middleware: [loggerMiddleware({ sink: jsonSink() })],
});
```

Each call writes one record, for example `{ kind: 'call', outcome: 'ok', provider: 'primary', model: 'gpt-4o', durationMs: 842, attempts: 1, usage: { totalTokens: 52 } }`, plus the path, retries, cache and stream details. Prompt text, output text and error messages are never recorded.

```ts
const logger = loggerMiddleware({
  sink: consoleSink(),
  slowCall: { aboveLivePercentile: 0.99 },
  sample: { success: 0.1 },
});

logger.stats.quantile({ provider: 'primary' }, 0.99); // rolling p99 in ms
logger.dispose(); // on shutdown
```

Register one instance per `VernLLM`. `vern-llm` is a peer dependency, and the package has no other dependency. Sinks are `jsonSink`, `consoleSink` and `memorySink`, or any object with a `write(level, entry)` method.

Pair it with `vern-llm-otel` to put trace ids in every record: `loggerMiddleware({ enrich: [otelLogFields] })`.

See the [documentation](https://vernllm.dev/docs/extensions/logger) for every option.

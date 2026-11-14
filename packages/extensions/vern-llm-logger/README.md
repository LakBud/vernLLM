<p align="center">
  <img src="https://raw.githubusercontent.com/LakBud/vernLLM/main/apps/docs/public/extensions/vernllm-logger.png" alt="vern-llm-logger logo" width="96" />
</p>

<h1 align="center">vern-llm-logger</h1>

<p align="center">Structured call logs, rolling latency percentiles, and slow call and error detection for <a href="https://github.com/LakBud/vernLLM/tree/main/packages/vern-llm">vern-llm</a>.</p>

When an LLM call is slow or fails, the useful questions are which provider, on which attempt, and whether it is getting worse. A provider dashboard can't answer them, because retries, fallbacks, and queue waits happen in your process. `vern-llm-logger` is one middleware that writes one structured record per call with the whole path in it, and keeps rolling latency percentiles so "slow" means slow for that target.

## Installation

```bash
npm i vern-llm-logger
```

`vern-llm` is a peer dependency, and the package has no other dependency.

## Quick start

```ts
import { VernLLM } from 'vern-llm';
import { jsonSink, loggerMiddleware } from 'vern-llm-logger';

const llm = new VernLLM({
  client,
  model: 'gpt-6-sol',
  middleware: [loggerMiddleware({ sink: jsonSink() })],
});
```

Every call now writes one record. This one timed out on its primary and was answered by a fallback:

```json
{
  "kind": "call",
  "outcome": "ok",
  "provider": "fallback[0]",
  "model": "claude-sonnet-5-5",
  "attempts": 2,
  "durationMs": 9412.4,
  "attemptMs": 1210.8,
  "path": [
    {
      "provider": "primary",
      "outcome": "error",
      "elapsedMs": 8120,
      "errorCode": "request_timeout"
    },
    { "provider": "fallback[0]", "outcome": "ok", "elapsedMs": 1210.8 }
  ],
  "usage": { "promptTokens": 412, "completionTokens": 87, "totalTokens": 499 }
}
```

With `consoleSink()` the same call is one readable line: `[VernLLM] ok fallback[0]/claude-sonnet-5-5 9.41s 2 attempts req_abc`.

## What you get

| Capability          | How it works                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| One record per call | Retries, fallbacks, rate limit waits, cache hits, and stream details land in a single entry, not scattered lines |
| Rolling percentiles | A bounded memory sketch with 1 percent relative error, kept per provider, model, and any dimension you add       |
| Honest latency      | Only successful provider calls are timed, so a fast 400 or a slow timeout can't distort a p99                    |
| Slow call detection | A fixed threshold, or the target's own live p99, so a slow model isn't flagged for being itself                  |
| Error groups        | A burst of one error becomes a single `error_group` entry with a count, not hundreds of lines                    |
| Sampling            | Keep every failure and a share of plain successes                                                                |
| Privacy             | Prompt text, output text, and error messages are never recorded                                                  |
| Safety              | A failure inside the logger never changes a call                                                                 |

## Usage

### Reading live stats

```ts
const logger = loggerMiddleware({
  sink: consoleSink(),
  slowCall: { aboveLivePercentile: 0.99 },
  sample: { success: 0.1 },
});

logger.stats.quantile({ provider: 'primary' }, 0.99); // rolling p99 in ms
logger.stats.quantile({ provider: 'primary' }, 0.5, 'outputTokens'); // typical answer length
logger.stats.failureRate({ provider: 'primary' }, 'quality'); // share of answers rejected as unusable
logger.dispose(); // on shutdown
```

The same stats feed [`vern-llm-router`](https://www.npmjs.com/package/vern-llm-router) and [`vern-llm-hedge`](https://www.npmjs.com/package/vern-llm-hedge), so routing and hedging decisions come from your own measured traffic.

### Sinks and enrichment

Sinks are `jsonSink`, `consoleSink`, and `memorySink`, or any object with a `write(level, entry)` method. Pair the logger with `vern-llm-otel` to put trace ids on every record:

```ts
loggerMiddleware({ enrich: [otelLogFields] });
```

Register one instance per `VernLLM`.

## Documentation

See the [logger docs](https://vernllm.dev/docs/extensions/logger) for [call records](https://vernllm.dev/docs/extensions/logger/features/call-records), [detection](https://vernllm.dev/docs/extensions/logger/features/detection), [stats](https://vernllm.dev/docs/extensions/logger/features/stats), and every option.

## License

MIT

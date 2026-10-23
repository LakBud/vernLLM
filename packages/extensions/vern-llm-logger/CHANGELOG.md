# vern-llm-logger

## 0.1.0

### Minor Changes

- d7f3a2c: Introducing `vern-llm-logger`: structured call logs and rolling latency percentiles for vern-llm, built only on its public middleware system.

  ```ts
  import { VernLLM } from 'vern-llm';
  import { loggerMiddleware } from 'vern-llm-logger';

  const logger = loggerMiddleware();
  const llm = new VernLLM({ client, model: 'gpt-4o', middleware: [logger] });

  logger.stats.quantile({ provider: 'openai' }, 0.99);
  ```

  It writes one entry per call with the attempt path, outcome (`ok`, `error`, `aborted`, `rejected`), timings, token counts and cache hits or joins, and never prompt text, output or error messages. It also marks slow calls, groups repeated errors, samples successes, writes periodic summaries with an exemplar, and records circuit breaker changes. Sinks are `jsonSink`, `consoleSink` and `memorySink`, and `fromEvent` turns any custom event into a dimension.

  A new package, so nothing existing changes. It reads `CallResult.cache` from vern-llm, so it needs a vern-llm release that has it.

### Patch Changes

- Updated dependencies: vern-llm@3.1.0

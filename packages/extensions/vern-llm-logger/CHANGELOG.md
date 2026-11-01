# vern-llm-logger

## 0.1.0

### Minor Changes

- d7f3a2c: Introducing `vern-llm-logger`: structured call logs and rolling latency percentiles for vern-llm, built only on its public middleware system. It writes one record per call with the attempt path, outcome (`ok`, `error`, `aborted`, `rejected`), timings, token counts and cache hits, and never prompt text, output or error messages. A call refused for its content with `content_blocked` is logged as `rejected`, not as an error. Calls that run more than one chain with `next.again()` take their path, latency and usage from the kept chain only, so a cancelled chain never skews the latency series. Custom events in the `usage.*`, `policy.*`, `router.*`, `guard.*` and `hedge.*` namespaces are kept by default.

  ```ts
  import { VernLLM } from 'vern-llm';
  import { jsonSink, loggerMiddleware } from 'vern-llm-logger';

  const logger = loggerMiddleware({ sink: jsonSink(), slowCall: { aboveLivePercentile: 0.99 } });
  const llm = new VernLLM({ client, model: 'gpt-4o', middleware: [logger] });

  logger.stats.quantile({ provider: 'openai' }, 0.99); // rolling p99 in ms
  ```

  A new package, so existing code keeps compiling and behaving the same at runtime. It reads `CallResult.cache` from vern-llm, so it needs a vern-llm release that has it.

### Patch Changes

- Updated dependencies: vern-llm@3.1.0

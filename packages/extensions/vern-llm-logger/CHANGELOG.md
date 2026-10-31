# vern-llm-logger

## 0.1.0

### Minor Changes

- eb2f66c: A call refused by a middleware for its content, with the code `content_blocked`, is logged as `rejected` at `warn`, like a budget or policy refusal, and no longer counts as an error. Custom events in the `guard.*` namespace are kept by default, next to `usage.*`, `policy.*` and `router.*`.
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

- 8b6aabc: `hedge.*` joins the default custom events, next to `usage.*`, `policy.*`, `router.*` and `guard.*`.

### Patch Changes

- 9431c61: Records are correct for calls that run more than one chain with `next.again()`. Each chain's attempts are kept apart, so one chain no longer closes another's. A record for such a call sets `chains` and the kept `chain`, and takes `path`, `attemptMs`, `ttftMs` and `usage` from the kept chain only, so a cancelled chain never skews the latency series. `attempts` and `retries` still count every chain. Calls with one chain are recorded exactly as before.
- Updated dependencies: vern-llm@3.1.0

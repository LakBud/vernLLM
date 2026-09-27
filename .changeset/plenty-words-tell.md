---
'vern-llm': minor
---

Middleware dispatch hook, adapter context, a configurable Retry-After cap, an opt-in reader stall timeout, Claude thinking blocks in tool loops, and request fixes for newer Claude and GPT models.

Middleware: a new `dispatch` hook wraps each attempt's provider request, after the rate limiter and every `transform`, and sees exactly what is sent. It observes the request, it can't change the outcome. `AttemptContext.adapter` and `PreDispatchContext.primaryAdapter` name the adapter and, when certain, the provider. Every context gains `transformMiddlewareNames`. `LLMClient` gains optional `adapter` and `setLogger`. `fromOpenAICompatible` takes a `provider` option and `fromFetch` a `provider` field.

Retries: `maxRetryAfterMs` caps the honored Retry-After wait and `LLMError.retryAfterMs`. The default stays 10 seconds.

Streaming: `readerStallTimeoutMs`, off by default, detaches a `chunks` reader that holds a full buffer that long. Its next pull rejects with the new code `reader_stall_timeout`, and `finalResult` still settles.

Tools: with thinking on, `fromAnthropic` and `fromBedrock` return Claude's reasoning on `ToolCallResult.thinking`, and an assistant history turn takes it back, so a tool loop can continue.

```ts
history: [
  { role: 'assistant', toolCalls: first.toolCalls, thinking: first.thinking },
  { role: 'tool', toolResults },
];
```

Models: on Claude Fable 5.1 and later, Opus 5.5 and later, and every Claude major 6 and later, a forced `toolChoice` throws `unsupported_capability` before dispatch, and `jsonSchema` uses native structured output. GPT-6 and later with tools get `reasoning_effort: "none"` when no reasoning was asked for, and throw `unsupported_capability` when it was. `forcedToolChoiceUnsupportedModels` and `noReasoningToolModels` replace either rule.

Usage: `fromAnthropic` now counts `cache_creation_input_tokens` in `promptTokens` and `totalTokens`, since Anthropic counts cache writes toward its input rate limit. Before, the rate limiter saw more headroom than it had whenever prompt caching wrote to the cache. Cache reads stay out, as Anthropic doesn't count them. Reported usage rises by the cache writes for those calls.

Existing code keeps compiling unless it has an exhaustive `switch` over `LLMErrorCode` or `WireStreamChunk`, which needs a case for `reader_stall_timeout` or `thinking_block`, or builds `AttemptContext`/`PreDispatchContext` objects by hand, which need the new fields. At runtime every request that works today behaves the same. The requests that change already fail at the provider: they now either succeed or fail earlier with a clearer error.

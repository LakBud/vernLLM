import { describe, it, expect } from 'vitest';

import {
  fromAnthropic,
  fromBedrockClient,
  fromOpenAICompatible,
  NormalizedCacheAdapter,
  TieredCacheAdapter,
  parseSseStream,
  SSE_PING,
  isLLMError,
  hasIssues,
  isFallbackExhaustedError,
  FallbackExhaustedError,
  LLMError,
  type AnthropicClient,
  type BedrockConverseClient,
  type GeminiClient,
  type LLMClient,
  type JsonSchemaSpec,
  type RetryAttempt,
} from '../../src/index.js';

describe('package entrypoint exports', () => {
  it('exports adapters at runtime', () => {
    expect(fromAnthropic).toBeDefined();
    expect(fromOpenAICompatible).toBeDefined();
    expect(fromBedrockClient).toBeDefined();
    expect(typeof fromBedrockClient).toBe('function');
  });

  it('exports cache adapters at runtime', () => {
    expect(NormalizedCacheAdapter).toBeDefined();
    expect(TieredCacheAdapter).toBeDefined();
  });

  it('exports parseSseStream and SSE_PING from the package root, not just internal/sse.js', () => {
    expect(parseSseStream).toBeDefined();
    expect(typeof parseSseStream).toBe('function');
    expect(SSE_PING).toBeDefined();
    expect(typeof SSE_PING).toBe('symbol');
  });

  it('exports isLLMError and hasIssues as runtime functions from the package root', () => {
    expect(typeof isLLMError).toBe('function');
    expect(typeof hasIssues).toBe('function');

    expect(isLLMError(new LLMError('boom', 'unknown'))).toBe(true);
    expect(isLLMError(new Error('plain error'))).toBe(false);
    expect(isLLMError('not an error')).toBe(false);
    expect(isLLMError(undefined)).toBe(false);

    const withIssues = new LLMError('dup', 'invalid_params', {
      code: 'duplicate_tool_names',
      issues: { names: ['a'] },
    });
    const withoutIssues = new LLMError('unrelated', 'invalid_params', {
      code: 'unsupported_capability',
    });

    expect(hasIssues(withIssues, 'duplicate_tool_names')).toBe(true);
    expect(hasIssues(withIssues, 'unsupported_capability')).toBe(false);
    expect(hasIssues(withoutIssues, 'duplicate_tool_names')).toBe(false);
  });

  it('exports isFallbackExhaustedError as a runtime function from the package root', () => {
    expect(typeof isFallbackExhaustedError).toBe('function');

    const exhausted = new FallbackExhaustedError([
      { index: -1, provider: 'primary', model: 'm', error: new LLMError('down', 'api') },
      { index: 0, provider: 'fallback-1', model: 'm2', error: new LLMError('down', 'api') },
    ]);

    expect(isFallbackExhaustedError(exhausted)).toBe(true);
    expect(isFallbackExhaustedError(new LLMError('down', 'api'))).toBe(false);
  });

  it('exports public client and schema types', () => {
    const assertClient = (_client: LLMClient) => _client;
    const assertAnthropicClient = (_client: AnthropicClient) => _client;
    const assertGeminiClient = (_client: GeminiClient) => _client;
    const assertBedrockClient = (_client: BedrockConverseClient) => _client;
    const assertSchema = (_schema: JsonSchemaSpec) => _schema;
    const assertRetryAttempt = (_attempt: RetryAttempt) => _attempt;

    expect(assertClient).toBeDefined();
    expect(assertAnthropicClient).toBeDefined();
    expect(assertGeminiClient).toBeDefined();
    expect(assertBedrockClient).toBeDefined();
    expect(assertSchema).toBeDefined();
    expect(assertRetryAttempt).toBeDefined();
  });
});

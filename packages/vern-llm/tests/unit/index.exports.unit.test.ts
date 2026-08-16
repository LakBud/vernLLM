import { describe, it, expect } from 'vitest';

import {
  fromAnthropic,
  fromOpenAICompatible,
  NormalizedCacheAdapter,
  TieredCacheAdapter,
  parseSseStream,
  SSE_PING,
  isLLMError,
  hasIssues,
  LLMError,
  type AnthropicClient,
  type BedrockConverseClient,
  type GeminiClient,
  type LLMClient,
  type JsonSchemaSpec,
} from '../../src/index.js';

describe('package entrypoint exports', () => {
  it('exports adapters at runtime', () => {
    expect(fromAnthropic).toBeDefined();
    expect(fromOpenAICompatible).toBeDefined();
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

  it('exports public client and schema types', () => {
    const assertClient = (_client: LLMClient) => _client;
    const assertAnthropicClient = (_client: AnthropicClient) => _client;
    const assertGeminiClient = (_client: GeminiClient) => _client;
    const assertBedrockClient = (_client: BedrockConverseClient) => _client;
    const assertSchema = (_schema: JsonSchemaSpec) => _schema;

    expect(assertClient).toBeDefined();
    expect(assertAnthropicClient).toBeDefined();
    expect(assertGeminiClient).toBeDefined();
    expect(assertBedrockClient).toBeDefined();
    expect(assertSchema).toBeDefined();
  });
});
